import { paginator } from "convex-helpers/server/pagination";
import {
  createFunctionHandle,
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  type DocumentByName,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  getFunctionAddress,
  getFunctionName,
  internalMutationGeneric,
  makeFunctionReference,
  type MutationBuilder,
  type NamedTableInfo,
  type OrderedQuery,
  type QueryInitializer,
  type RegisteredMutation,
  type SchemaDefinition,
  type TableDefinition,
  type TableNamesInDataModel,
} from "convex/server";
import {
  type MigrationArgs,
  migrationArgs,
  type MigrationResult,
  type MigrationStatus,
} from "../shared.js";
export type { MigrationArgs, MigrationResult, MigrationStatus };

import { ConvexError, type GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { MigrationFunctionHandle } from "../component/lib.js";
import { logStatusAndInstructions } from "./log.js";

// Note: this value is hard-coded in the docstring below. Please keep in sync.
export const DEFAULT_BATCH_SIZE = 100;

export class Migrations<
  DM extends GenericDataModel,
  Schema extends SchemaDefinition<any, boolean> | void = void,
  DataModel extends GenericDataModel = Schema extends SchemaDefinition<
    any,
    boolean
  >
    ? DataModelFromSchemaDefinition<Schema>
    : DM,
> {
  /**
   * Makes the migration wrapper, with types for your own tables.
   *
   * It will keep track of migration state.
   * Add in convex/migrations.ts for example:
   * ```ts
   * import { Migrations } from "@convex-dev/migrations";
   * import { components } from "./_generated/api.js";
   * import { internalMutation } from "./_generated/server";
   *
   * export const migrations = new Migrations(components.migrations, { internalMutation });
   *
   * export const myMigration = migrations.define({
   *  table: "users",
   *  migrateOne: async (ctx, doc) => {
   *    await ctx.db.patch(doc._id, { someField: "value" });
   *  }
   * });
   * ```
   * You can then run it from the CLI or dashboard:
   * ```sh
   * npx convex run migrations:myMigration
   * ```
   * For starting a migration from code, see {@link runOne}/{@link runSerially}.
   * @param component - The migrations component. It will be on components.migrations
   * after being configured in in convex.config.js.
   * @param options - Configure options and set the internalMutation to use.
   */
  constructor(
    public component: ComponentApi,
    public options?: {
      /**
       * Uses the internal mutation to run the migration.
       * This also provides the types for your tables.
       * ```ts
       * import { internalMutation } from "./_generated/server.js";
       * ```
       */
      internalMutation?: MutationBuilder<DataModel, "internal">;
      /**
       * How many documents to process in a batch.
       * Your migrateOne function will be called for each document in a batch in
       * a single transaction.
       */
      defaultBatchSize?: number;
      /**
       * Prefix to add to the function name when running migrations.
       * For example, if you have a function named "foo" in a file
       * "convex/bar/baz.ts", you can set {migrationsLocationPrefix: "bar/baz:"}
       * and then run:
       * ```sh
       * npx convex run migrations:run '{"fn": "foo"}'
       * ```
       */
      migrationsLocationPrefix?: string;
      /**
       * The schema for your database. Required when using customRange.
       * ```ts
       * import schema from "./schema.js";
       *
       * const migrations = new Migrations(components.migrations, {
       *   schema,
       * });
       * ```
       */
      schema?: Schema;
    },
  ) {}

  /**
   * Creates a migration runner that can be called from the CLI or dashboard.
   *
   * For starting a migration from code, see {@link runOne}/{@link runSerially}.
   *
   * It can be created for a specific migration:
   * ```ts
   * export const runMyMigration = runner(internal.migrations.myMigration);
   * ```
   * CLI: `npx convex run migrations:runMyMigration`
   *
   * Or for any migration:
   * ```ts
   * export const run = runner();
   * ```
   * CLI: `npx convex run migrations:run '{"fn": "migrations:myMigration"}'`
   *
   * Where `myMigration` is the name of the migration function, defined in
   * "convex/migrations.ts" along with the run function.
   *
   * @param specificMigration If you want a migration runner for one migration,
   * pass in the migration function reference like `internal.migrations.foo`.
   * Otherwise it will be a generic runner that requires the migration name.
   * @returns An internal mutation,
   */
  runner(
    specificMigrationOrSeries?:
      | MigrationFunctionReference
      | MigrationFunctionReference[],
  ) {
    return internalMutationGeneric({
      args: migrationArgs,
      handler: async (ctx, args) => {
        const [specificMigration, next] = Array.isArray(
          specificMigrationOrSeries,
        )
          ? [
              specificMigrationOrSeries[0],
              await Promise.all(
                specificMigrationOrSeries.slice(1).map(async (fnRef) => ({
                  name: getFunctionName(fnRef),
                  fnHandle: await createFunctionHandle(fnRef),
                })),
              ),
            ]
          : [specificMigrationOrSeries, undefined];
        if (args.fn && specificMigration) {
          throw new Error("Specify only one of fn or specificMigration");
        }
        if (!args.fn && !specificMigration) {
          throw new Error(
            `Specify the migration: '{"fn": "migrations:foo"}'\n` +
              "Or initialize a `runner` runner specific to the migration like\n" +
              "`export const runMyMigration = runner(internal.migrations.myMigration)`",
          );
        }
        return await this._runInteractive(ctx, args, specificMigration, next);
      },
    });
  }

  /**
   * Checks whether any of the given migrations is already running before we try
   * to start them, so the caller can bail instead of provoking an OCC conflict
   * with the batches an in-progress migration is actively writing. This is a
   * common problem when re-running migrations from a deploy script.
   *
   * We check all the names because starting a series attempts each migration in
   * turn, so any one being in progress can conflict - not just the first. A
   * serial series is self-propagating (each migration starts the next when it
   * finishes), so bailing still lets the in-flight series run to completion.
   *
   * From a mutation we read from a stale snapshot so this check itself doesn't
   * add a read dependency that would conflict. useStaleSnapshot only applies
   * inside a mutation transaction; an action runs each query in its own
   * transaction, so there's no calling transaction to protect.
   *
   * Note: a migration may have just finished by the time this transaction
   * commits, but that's fine - the goal is only to avoid starting it again, and
   * a completed migration is a no-op to start anyway.
   *
   * @returns The status of an in-progress migration, if any, else undefined.
   */
  private async anyInProgress(
    ctx: MutationCtx | ActionCtx,
    names: string[],
  ): Promise<MigrationStatus | undefined> {
    const { type } = await ctx.meta.getFunctionMetadata();
    const statuses =
      type === "mutation"
        ? await (ctx as MutationCtx).runQuery(
            this.component.lib.getStatus,
            { names },
            { useStaleSnapshot: true },
          )
        : await ctx.runQuery(this.component.lib.getStatus, { names });
    return statuses.find((s) => s.state === "inProgress");
  }

  private async _runInteractive(
    ctx: MutationCtx | ActionCtx,
    args: MigrationArgs,
    fnRef?: MigrationFunctionReference,
    next?: { name: string; fnHandle: string }[],
  ) {
    const name = args.fn ? this.prefixedName(args.fn) : getFunctionName(fnRef!);
    async function makeFn(fn: string) {
      try {
        return await createFunctionHandle(
          makeFunctionReference<"mutation">(fn),
        );
      } catch {
        throw new Error(
          `Can't find function ${fn}\n` +
            "The name should match the folder/file:method\n" +
            "See https://docs.convex.dev/functions/query-functions#query-names",
        );
      }
    }
    const fnHandle = args.fn
      ? await makeFn(name)
      : await createFunctionHandle(fnRef!);
    if (args.next) {
      next = (next ?? []).concat(
        await Promise.all(
          args.next.map(async (nextFn) => ({
            name: this.prefixedName(nextFn),
            fnHandle: await makeFn(this.prefixedName(nextFn)),
          })),
        ),
      );
    }
    // Bail if any migration in the series is already running, to avoid an OCC
    // conflict with its batches. Unless we're resetting, which explicitly asks
    // to restart from the beginning.
    if (!args.reset) {
      const inProgress = await this.anyInProgress(ctx, [
        name,
        ...(next ?? []).map((n) => n.name),
      ]);
      if (inProgress) {
        const { componentPath } = await getFunctionMetadata();
        return logStatusAndInstructions(
          inProgress.name,
          inProgress,
          args,
          componentPath,
        );
      }
    }
    // Handle reset option: reset sets cursor to null for all migrations
    const cursor = args.reset ? null : args.cursor;
    let status: MigrationStatus;
    try {
      status = await ctx.runMutation(this.component.lib.migrate, {
        name,
        fnHandle,
        cursor,
        batchSize: args.batchSize,
        next,
        dryRun: args.dryRun ?? false,
        reset: args.reset,
      });
    } catch (e) {
      if (
        args.dryRun &&
        e instanceof ConvexError &&
        e.data.kind === "DRY RUN"
      ) {
        status = e.data.status;
      } else {
        throw e;
      }
    }

    const { componentPath } = await getFunctionMetadata();
    return logStatusAndInstructions(name, status, args, componentPath);
  }

  /**
   * Use this to wrap a mutation that will be run over all documents in a table.
   * Your mutation only needs to handle changing one document at a time,
   * passed into migrateOne.
   * Optionally specify a custom batch size to override the default (100).
   *
   * In convex/migrations.ts for example:
   * ```ts
   * export const foo = migrations.define({
   *  table: "users",
   *  migrateOne: async (ctx, doc) => {
   *   await ctx.db.patch(doc._id, { someField: "value" });
   *  },
   * });
   * ```
   *
   * You can run this manually from the CLI or dashboard:
   * ```sh
   * # Start or resume a migration. No-ops if it's already done:
   * npx convex run migrations:foo
   *
   * # Restart a migration from the beginning (also resets next migrations):
   * npx convex run migrations:foo '{reset: true}'
   *
   * # Dry run - runs one batch but doesn't schedule or commit changes,
   * # so you can see what it would do without committing the transaction.
   * npx convex run migrations:foo '{dryRun: true}'
   *
   * # Run many migrations serially:
   * npx convex run migrations:foo '{next: ["migrations:bar", "migrations:baz"]}'
   * ```
   *
   * See {@link runOne} and {@link runSerially} for programmatic use.
   *
   * @param table - The table to run the migration over.
   * @param migrateOne - The function to run on each document.
   * @param batchSize - The number of documents to process in a batch.
   *   If not set, defaults to the value passed to makeMigration,
   *   or {@link DEFAULT_BATCH_SIZE}. Overriden by arg at runtime if supplied.
   * @param parallelize - If true, each migration batch will be run in parallel.
   * @returns An internal mutation that runs the migration.
   */
  define<TableName extends TableNamesInDataModel<DataModel>>({
    table,
    migrateOne,
    customRange,
    batchSize: functionDefaultBatchSize,
    parallelize,
  }: {
    table: TableName;
    migrateOne: (
      ctx: GenericMutationCtx<DataModel>,
      doc: DocumentByName<DataModel, TableName> & { _id: GenericId<TableName> },
    ) =>
      | void
      | Partial<DocumentByName<DataModel, TableName>>
      | Promise<Partial<DocumentByName<DataModel, TableName>> | void>;
    customRange?: (
      q: QueryInitializer<NamedTableInfo<DataModel, TableName>>,
    ) => OrderedQuery<NamedTableInfo<DataModel, TableName>>;
    batchSize?: number;
    parallelize?: boolean;
  }) {
    const defaultBatchSize =
      functionDefaultBatchSize ??
      this.options?.defaultBatchSize ??
      DEFAULT_BATCH_SIZE;
    // Under the hood it's an internal mutation that calls the migrateOne
    // function for every document in a page, recursively scheduling batches.
    return (
      (this.options?.internalMutation as MutationBuilder<
        DataModel,
        "internal"
      >) ?? (internalMutationGeneric as MutationBuilder<DataModel, "internal">)
    )({
      args: migrationArgs,
      handler: async (ctx, args) => {
        // Auto-detect function name for direct CLI/dashboard invocation.
        // The component always provides cursor and dryRun when scheduling
        // batches, so if either is missing this is a direct invocation.
        if (!args.oneBatchOnly) {
          if (args.cursor === "" || args.batchSize === 0) {
            console.warn(
              "Running this from the CLI or dashboard? Here's some args to use:",
            );
            console.warn({
              "Dry run": '{ "dryRun": true, "reset": true }',
              "For real": "{}",
            });
            return;
          }
          const metadata = await getFunctionMetadata();
          if (args.fn && this.prefixedName(args.fn) !== metadata.name) {
            const componentFlag = metadata.componentPath
              ? ` --component ${metadata.componentPath}`
              : "";
            throw new Error(
              `Function name mismatch: expected ${metadata.name}, got ${args.fn}. Hint: you can call it directly with \`npx convex run ${metadata.name}${componentFlag}\`.`,
            );
          }
          return (await this._runInteractive(
            ctx,
            args,
            makeFunctionReference(
              metadata.name,
            ) as unknown as MigrationFunctionReference,
          )) as any;
        }

        const numItems = args.batchSize || defaultBatchSize;
        if (args.cursor === undefined || args.cursor === "") {
          if (args.dryRun === undefined) {
            console.warn(
              "No cursor or dryRun specified - doing a dry run on the next batch.",
            );
            args.cursor = null;
            args.dryRun = true;
          } else if (args.dryRun) {
            console.warn("Setting cursor to null for dry run");
            args.cursor = null;
          } else {
            throw new Error(`Cursor must be specified for a one-off execution.
              Use null to start from the beginning.
              Use the value in the migrations database to pick up from where it left off.`);
          }
        }

        // Determine which pagination method to use
        const cursorIsOldFormat =
          args.cursor !== null &&
          args.cursor !== undefined &&
          !isNewFormatCursor(args.cursor);

        // Use paginator when cursor is compatible.
        // Falls back to built-in db.query for old-format cursors from
        // in-progress migrations that started before the paginator was used.
        const useNewPaginator = !cursorIsOldFormat;
        if (useNewPaginator && customRange && !this.options?.schema) {
          throw new Error(
            `You must provide your schema to use a custom range.`,
          );
        }
        const paginatorSchema = (this.options?.schema ??
          defineSchema({ [table]: defineTable({}) })) as SchemaDefinition<
          Record<TableName, TableDefinition>,
          true
        >;

        // Build the query using either paginator or built-in db.query
        // Both implement compatible QueryInitializer interfaces
        const q = useNewPaginator
          ? (paginator(ctx.db as any, paginatorSchema).query(
              table,
            ) as unknown as QueryInitializer<
              NamedTableInfo<DataModel, TableName>
            >)
          : ctx.db.query(table);
        const range = customRange ? customRange(q) : q;
        let continueCursor: string;
        let page: DocumentByName<DataModel, TableName>[];
        let isDone: boolean;
        try {
          ({ continueCursor, page, isDone } = await range.paginate({
            cursor: args.cursor,
            numItems,
            maximumBytesRead: 2 << 20, // 2 MiB
          }));
        } catch (e) {
          console.error(
            "Error paginating. This can happen if the migration " +
              "was initially run on a different table, different custom range, " +
              "or you upgraded convex-helpers with in-progress migrations. " +
              "This creates an invalid pagination cursor. " +
              "Run all migrations to completion on the old cursor, or re-run " +
              "them explicitly with the cursor set to null. " +
              "If the problem persists, contact support@convex.dev",
          );
          throw e;
        }
        async function doOne(doc: DocumentByName<DataModel, TableName>) {
          try {
            const next = await migrateOne(
              ctx,
              doc as { _id: GenericId<TableName> },
            );
            if (next && Object.keys(next).length > 0) {
              await ctx.db.patch(table, doc._id as GenericId<TableName>, next);
            }
          } catch (error) {
            console.error(`Document failed: ${doc._id}`);
            throw error;
          }
        }
        let processedCount = 0;
        let shortCircuited = false;
        if (parallelize) {
          await Promise.all(page.map(doOne));
          processedCount = page.length;
        } else {
          for (const doc of page) {
            // Only short-circuit when using the new paginator, since we
            // need to re-paginate for an exact cursor. Without it we'd
            // return the same cursor and re-process documents.
            if (useNewPaginator && processedCount > 0) {
              const metrics = await getTransactionMetrics();
              if (isNearTransactionLimits(metrics)) {
                const remaining = page.length - processedCount;
                console.log(
                  `Short-circuiting batch after processing ` +
                    `${processedCount}/${page.length} documents due to ` +
                    `transaction limits. ${remaining} documents will be ` +
                    `retried in the next batch.`,
                );
                shortCircuited = true;
                break;
              }
            }
            await doOne(doc);
            processedCount++;
          }
        }
        let shortCircuitCursor: string = continueCursor;
        if (shortCircuited && processedCount > 0) {
          // Re-paginate with the exact count to get a precise cursor.
          const q2 = paginator(ctx.db as any, paginatorSchema as any).query(
            table,
          ) as unknown as QueryInitializer<
            NamedTableInfo<DataModel, TableName>
          >;
          const range2 = customRange ? customRange(q2) : q2;
          const { continueCursor: exactCursor } = await (
            range2 as any
          ).paginate({
            cursor: args.cursor,
            numItems: processedCount,
          });
          shortCircuitCursor = exactCursor;
        }
        const result: MigrationResult = {
          continueCursor: shortCircuited ? shortCircuitCursor : continueCursor,
          isDone: shortCircuited ? false : isDone,
          processed: processedCount,
        };
        if (args.dryRun) {
          // Throwing an error rolls back the transaction
          let anyChanges = false;
          let printedChanges = 0;
          for (const before of page) {
            const after = await ctx.db.get(
              table,
              before._id as GenericId<TableName>,
            );
            if (JSON.stringify(after) !== JSON.stringify(before)) {
              anyChanges = true;
              printedChanges++;
              if (printedChanges > 10) {
                console.debug(
                  "DRY RUN: More than 10 changes were found in the first page. Skipping the rest.",
                );
                break;
              }
              console.debug("DRY RUN: Example change", {
                before,
                after,
              });
            }
          }
          if (!anyChanges) {
            console.debug(
              "DRY RUN: No changes were found in the first page. " +
                `Try {"dryRun": true, "cursor": "${continueCursor}"}`,
            );
          }
          throw new ConvexError({
            kind: "DRY RUN",
            result,
          });
        }
        if (args.dryRun === undefined) {
          // We are running it in a one-off mode.
          // The component will always provide dryRun.
          // A bit of a hack / implicit, but non-critical logging.
          console.debug(`Next cursor: ${continueCursor}`);
        }
        return result;
      },
    }) satisfies RegisteredMutation<
      "internal",
      MigrationArgs,
      Promise<MigrationResult>
    >;
  }

  /**
   * Start a migration from a server function via a function reference.
   *
   * ```ts
   * const migrations = new Migrations(components.migrations, { internalMutation });
   *
   * // in a mutation or action:
   *   await migrations.runOne(ctx, internal.migrations.myMigration, {
   *     cursor: null, // optional override
   *     batchSize: 10, // optional override
   *   });
   * ```
   *
   * Overrides any options you passed in, such as resetting the cursor.
   * If it's already in progress, it will no-op.
   * If you run a migration that had previously failed which was part of a series,
   * it will not resume the series.
   * To resume a series, call the series again: {@link Migrations.runSerially}.
   *
   * Note: It's up to you to determine if it's safe to run a migration while
   * others are in progress. It won't run multiple instance of the same migration
   * but it currently allows running multiple migrations on the same table.
   *
   * @param ctx Context from a mutation or action. Needs `runMutation`.
   * @param fnRef The migration function to run. Like `internal.migrations.foo`.
   * @param opts Options to start the migration.
   * @param opts.cursor The cursor to start from.
   *   null: start from the beginning.
   *   undefined: start or resume from where it failed. If done, it won't restart.
   * @param opts.reset If true, restarts the migration from the beginning.
   * @param opts.batchSize The number of documents to process in a batch.
   * @param opts.dryRun If true, it will run a batch and then throw an error.
   *   It's helpful to see what it would do without committing the transaction.
   */
  async runOne(
    ctx: MutationCtx | ActionCtx,
    fnRef: MigrationFunctionReference,
    opts?: {
      cursor?: string | null;
      batchSize?: number;
      dryRun?: boolean;
      reset?: boolean;
    },
  ) {
    const name = getFunctionName(fnRef);
    // Bail if it's already running to avoid an OCC conflict with its batches.
    // Skip this when resetting, which explicitly asks to restart.
    if (!opts?.reset) {
      const inProgress = await this.anyInProgress(ctx, [name]);
      if (inProgress) return inProgress;
    }
    return ctx.runMutation(this.component.lib.migrate, {
      name,
      fnHandle: await createFunctionHandle(fnRef),
      cursor: opts?.reset ? null : opts?.cursor,
      batchSize: opts?.batchSize,
      dryRun: opts?.dryRun ?? false,
      reset: opts?.reset,
    });
  }

  /**
   * Start a series of migrations, running one a time. Each call starts a series.
   *
   * ```ts
   * const migrations = new Migrations(components.migrations, { internalMutation });
   *
   * // in a mutation or action:
   *   await migrations.runSerially(ctx, [
   *    internal.migrations.myMigration,
   *    internal.migrations.myOtherMigration,
   *   ]);
   * ```
   *
   * It runs one batch at a time currently.
   * If a migration has previously completed it will skip it.
   * If a migration had partial progress, it will resume from where it left off.
   * If a migration is already in progress when attempted, it will no-op.
   * If a migration fails or is canceled, it will stop executing and NOT execute
   * any subsequent migrations in the series. Call the series again to retry.
   *
   * This is useful to run as an post-deploy script where you specify all the
   * live migrations that should be run.
   *
   * Note: if you start multiple serial migrations, the behavior is:
   * - If they don't overlap on functions, they will happily run in parallel.
   * - If they have a function in common and one completes before the other
   *   attempts it, the second will just skip it.
   * - If they have a function in common and one is in progress, the second will
   *   no-op and not run any further migrations in its series.
   *
   * To stop a migration in progress, see {@link cancelMigration}.
   *
   * @param ctx Context from a mutation or action. Needs `runMutation`.
   * @param fnRefs The migrations to run in order. Like [internal.migrations.foo].
   */
  async runSerially(
    ctx: MutationCtx | ActionCtx,
    fnRefs: MigrationFunctionReference[],
  ) {
    if (fnRefs.length === 0) return;
    const [fnRef, ...rest] = fnRefs;
    const name = getFunctionName(fnRef);
    // Bail if any migration in the series is already running, to avoid an OCC
    // conflict with its batches - the common case when re-running a post-deploy
    // script.
    const inProgress = await this.anyInProgress(
      ctx,
      fnRefs.map(getFunctionName),
    );
    if (inProgress) return inProgress;
    const next = await Promise.all(
      rest.map(async (fnRef) => ({
        name: getFunctionName(fnRef),
        fnHandle: await createFunctionHandle(fnRef),
      })),
    );
    return ctx.runMutation(this.component.lib.migrate, {
      name,
      fnHandle: await createFunctionHandle(fnRef),
      next,
      dryRun: false,
    });
  }

  /**
   * Get the status of a migration or all migrations.
   * @param ctx Context from a query, mutation or action. Needs `runQuery`.
   * @param migrations The migrations to get the status of. Defaults to all.
   * @param limit How many migrations to fetch, if not specified by name.
   * @returns The status of the migrations, in the order of the input.
   */
  async getStatus(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    {
      migrations,
      limit,
    }: {
      migrations?: (string | MigrationFunctionReference)[];
      limit?: number;
    },
  ): Promise<MigrationStatus[]> {
    const names = migrations?.map((m) =>
      typeof m === "string" ? this.prefixedName(m) : getFunctionName(m),
    );
    return ctx.runQuery(this.component.lib.getStatus, {
      names,
      limit,
    });
  }

  /**
   * Cancels a migration if it's in progress.
   * You can resume it later by calling the migration without an explicit cursor.
   * If the migration had "next" migrations, e.g. from {@link runSerially},
   * they will not run. To resume, call the series again or manually pass "next".
   * @param ctx Context from a mutation or action. Needs `runMutation`.
   * @param migration Migration to cancel. Either the name like "migrations:foo"
   * or the function reference like `internal.migrations.foo`.
   * @returns The status of the migration after attempting to cancel it.
   */
  async cancel(
    ctx: MutationCtx | ActionCtx,
    migration: MigrationFunctionReference | string,
  ): Promise<MigrationStatus> {
    const name =
      typeof migration === "string"
        ? this.prefixedName(migration)
        : getFunctionName(migration);
    return ctx.runMutation(this.component.lib.cancel, { name });
  }

  /**
   * Cancels all migrations that are in progress.
   * You can resume it later by calling the migration without an explicit cursor.
   * If the migration had "next" migrations, e.g. from {@link runSerially},
   * they will not run. To resume, call the series again or manually pass "next".
   * @param ctx Context from a mutation or action. Needs `runMutation`.
   * @returns The status of up to 100 of the canceled migrations.
   */
  async cancelAll(ctx: MutationCtx | ActionCtx) {
    return ctx.runMutation(this.component.lib.cancelAll, {});
  }

  // Helper to prefix the name with the location.
  // migrationsLocationPrefix of "bar/baz:" and name "foo" => "bar/baz:foo"
  private prefixedName(name: string) {
    return this.options?.migrationsLocationPrefix && !name.includes(":")
      ? `${this.options.migrationsLocationPrefix}${name}`
      : name;
  }
}

export type MigrationFunctionReference = FunctionReference<
  "mutation",
  "internal",
  MigrationArgs
>;

/**
 * Start a migration and run it synchronously until it's done.
 * If this function crashes, the migration will not continue.
 *
 * ```ts
 * // In an action
 * const toRun = internal.migrations.myMigration;
 * await runToCompletion(ctx, components.migrations, toRun);
 * ```
 *
 * If it's already in progress, it will no-op.
 * If you run a migration that had previously failed which was part of a series,
 * it will not resume the series.
 * To resume a series, call the series again: {@link Migrations.runSerially}.
 *
 * Note: It's up to you to determine if it's safe to run a migration while
 * others are in progress. It won't run multiple instances of the same migration
 * but it currently allows running multiple migrations on the same table.
 *
 * @param ctx Context from an action.
 * @param component The migrations component, usually `components.migrations`.
 * @param fnRef The migration function to run. Like `internal.migrations.foo`.
 * @param opts Options to start the migration.
 *   It's helpful to see what it would do without committing the transaction.
 */
export async function runToCompletion(
  ctx: ActionCtx,
  component: ComponentApi,
  fnRef: MigrationFunctionReference | MigrationFunctionHandle,
  opts?: {
    /**
     * The name of the migration function, generated with getFunctionName.
     */
    name?: string;
    /**
     * The cursor to start from.
     * null: start from the beginning.
     * undefined: start, or resume from where it failed. No-ops if already done.
     */
    cursor?: string | null;
    /**
     * The number of documents to process in a batch.
     * Overrides the migrations's configured batch size.
     */
    batchSize?: number;
    /**
     * If true, it will run a batch and then throw an error.
     * It's helpful to see what it would do without committing the transaction.
     */
    dryRun?: boolean;
  },
): Promise<MigrationStatus> {
  let cursor = opts?.cursor;
  const {
    name = getFunctionName(fnRef),
    batchSize,
    dryRun = false,
  } = opts ?? {};
  const address = getFunctionAddress(fnRef);
  const fnHandle =
    address.functionHandle ?? (await createFunctionHandle(fnRef));
  let previousProcessed = 0;
  while (true) {
    const status = await ctx.runMutation(component.lib.migrate, {
      name,
      fnHandle,
      cursor,
      batchSize,
      dryRun,
      oneBatchOnly: true,
    });
    if (status.isDone) {
      return status;
    }
    if (status.error) {
      throw new Error(status.error);
    }
    if (!status.cursor || status.cursor === cursor) {
      throw new Error(
        "Invariant violation: Migration did not make progress." +
          `\nStatus: ${JSON.stringify(status)}`,
      );
    }
    cursor = status.cursor;
  }
}

/**
 * Detects if a cursor is in the new paginator format (JSON array starting with "[")
 * or old built-in format (encrypted opaque string).
 *
 * New format cursors from convex-helpers paginator are JSON-serialized arrays like:
 * '["value", 1234567890, "documentId"]'
 *
 * Old format cursors from built-in .paginate() are encrypted opaque strings.
 *
 * @returns true if this is a new-format cursor (or null for starting fresh)
 */
export function isNewFormatCursor(cursor: string | null): boolean {
  if (cursor === null) return true;
  return typeof cursor === "string" && cursor.startsWith("[");
}

function isNearTransactionLimits(metrics: TransactionMetrics): boolean {
  for (const metric of Object.values(metrics) as TransactionMetric[]) {
    if (metric.remaining < metric.used) {
      return true;
    }
  }
  return false;
}

/* Type utils follow */

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "meta"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "storage" | "meta"
>;

// TODO: replace with ctx.meta.getFunctionMetadata() in 1.36+
export async function getFunctionMetadata(): Promise<{
  name: string;
  componentPath: string;
}> {
  const syscalls = (globalThis as any).Convex;
  return JSON.parse(
    await syscalls.asyncSyscall("1.0/getFunctionMetadata", JSON.stringify({})),
  );
}

type TransactionMetric = {
  used: number;
  remaining: number;
};

type TransactionMetrics = {
  bytesRead: TransactionMetric;
  bytesWritten: TransactionMetric;
  databaseQueries: TransactionMetric;
  documentsRead: TransactionMetric;
  documentsWritten: TransactionMetric;
  functionsScheduled: TransactionMetric;
  scheduledFunctionArgsBytes: TransactionMetric;
};

// TODO: replace with ctx.meta.getFunctionMetadata() in 1.36+
export async function getTransactionMetrics(): Promise<TransactionMetrics> {
  const syscalls = (globalThis as any).Convex;
  return JSON.parse(
    await syscalls.asyncSyscall(
      "1.0/getTransactionMetrics",
      JSON.stringify({}),
    ),
  );
}
