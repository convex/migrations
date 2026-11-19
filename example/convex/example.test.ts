import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { components, internal } from "./_generated/api";
import { runToCompletion } from "@convex-dev/migrations";
import { createFunctionHandle, getFunctionName } from "convex/server";
import { migrations } from "./example";

describe("example", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("test setDefaultValue migration", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });
    await t.run(async (ctx) => {
      const docs = await ctx.db.query("myTable").collect();
      expect(docs).toHaveLength(10);
      expect(docs.some((doc) => doc.optionalField === undefined)).toBe(true);
    });
    await t.run(async (ctx) => {
      await runToCompletion(
        ctx,
        components.migrations,
        internal.example.setDefaultValue,
        { batchSize: 2 },
      );
    });
    await t.run(async (ctx) => {
      const after = await ctx.db.query("myTable").collect();
      expect(after).toHaveLength(10);
      expect(after.every((doc) => doc.optionalField !== undefined)).toBe(true);
    });
  });

  test("test failingMigration", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });
    await expect(
      t.run(async (ctx) => {
        await runToCompletion(
          ctx,
          components.migrations,
          internal.example.failingMigration,
        );
      }),
    ).rejects.toThrow("This migration fails after the first");
  });

  test("runner runs one batch at a time and resumes from its saved cursor", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });

    for (const processed of [2, 4]) {
      await t.mutation(internal.example.runAll, {
        batchSize: 2,
        oneBatchOnly: true,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const [status] = await t.run((ctx) =>
        migrations.getStatus(ctx, {
          migrations: [internal.example.setDefaultValue],
        }),
      );
      expect(status.processed).toBe(processed);
      expect(status.isDone).toBe(false);
      expect(status.state).not.toBe("inProgress");
      const docs = await t.run((ctx) => ctx.db.query("myTable").collect());
      expect(
        docs.filter((doc) => doc.optionalField === "default"),
      ).toHaveLength(processed / 2);
    }
  });

  test("runner with oneBatchOnly does not start the next migration", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 1 });
    await t.mutation(internal.example.runAll, {
      batchSize: 2,
      oneBatchOnly: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const statuses = await t.query(internal.example.getStatus, {});
    expect(
      statuses.find(
        (status) =>
          status.name === getFunctionName(internal.example.setDefaultValue),
      ),
    ).toMatchObject({ processed: 1, isDone: true, state: "success" });
    expect(
      statuses
        .filter(
          (status) =>
            status.name !== getFunctionName(internal.example.setDefaultValue),
        )
        .every((status) => status.state === "unknown"),
    ).toBe(true);
  });

  test.each([undefined, false])(
    "runner continues scheduling when oneBatchOnly is %s",
    async (oneBatchOnly) => {
      const t = initConvexTest();
      await t.mutation(internal.example.seed, { count: 10 });
      await t.mutation(internal.example.runAll, { batchSize: 2, oneBatchOnly });
      const [status] = await t.run((ctx) =>
        migrations.getStatus(ctx, {
          migrations: [internal.example.setDefaultValue],
        }),
      );
      expect(status).toMatchObject({ processed: 2, state: "inProgress" });
    },
  );

  test("runOne no-ops when the migration is already in progress", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });
    // batchSize 2 over 10 docs runs one batch and schedules a worker for the
    // next, leaving the migration in progress (a pending worker).
    const first = await t.run((ctx) =>
      migrations.runOne(ctx, internal.example.setDefaultValue, {
        batchSize: 2,
      }),
    );
    expect(first?.state).toBe("inProgress");
    expect(first?.processed).toBe(2);
    // A second attempt while it's in progress should bail without running
    // another batch (which would OCC against the in-flight batches).
    const second = await t.run((ctx) =>
      migrations.runOne(ctx, internal.example.setDefaultValue, {
        batchSize: 2,
      }),
    );
    expect(second?.state).toBe("inProgress");
    expect(second?.processed).toBe(first?.processed);
  });

  test("runSerially no-ops when the first migration is already in progress", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });
    const first = await t.run((ctx) =>
      migrations.runOne(ctx, internal.example.setDefaultValue, {
        batchSize: 2,
      }),
    );
    expect(first?.state).toBe("inProgress");
    // Re-running the series (e.g. a re-invoked post-deploy script) should
    // detect the in-progress migration and no-op rather than restart it.
    const second = await t.run((ctx) =>
      migrations.runSerially(ctx, [
        internal.example.setDefaultValue,
        internal.example.validateRequiredField,
      ]),
    );
    expect(second?.name).toBe(getFunctionName(internal.example.setDefaultValue));
    expect(second?.state).toBe("inProgress");
    expect(second?.processed).toBe(first?.processed);
  });

  test("runSerially no-ops when a later migration in the series is in progress", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });
    // Put a *later* migration in the series in progress (a pending worker).
    const started = await t.run((ctx) =>
      migrations.runOne(ctx, internal.example.setDefaultValue, {
        batchSize: 2,
      }),
    );
    expect(started?.state).toBe("inProgress");
    // Run a series whose *first* migration isn't in progress, but a later one
    // is. `migrate` would walk the series and read the in-progress migration's
    // hot state row (an OCC risk), so we should detect it and bail without
    // running the first migration at all.
    const result = await t.run((ctx) =>
      migrations.runSerially(ctx, [
        internal.example.clearField,
        internal.example.setDefaultValue,
      ]),
    );
    expect(result?.name).toBe(
      getFunctionName(internal.example.setDefaultValue),
    );
    expect(result?.state).toBe("inProgress");
    // The first migration in the series never ran (else its state would exist).
    const [clearFieldStatus] = await t.run((ctx) =>
      migrations.getStatus(ctx, {
        migrations: [internal.example.clearField],
      }),
    );
    expect(clearFieldStatus.state).toBe("unknown");
    expect(clearFieldStatus.isDone).toBe(false);
  });

  test("test migrating with function handle", async () => {
    const t = initConvexTest();
    await t.mutation(internal.example.seed, { count: 10 });
    await t.run(async (ctx) => {
      const docs = await ctx.db.query("myTable").collect();
      expect(docs).toHaveLength(10);
      expect(docs.some((doc) => doc.optionalField === undefined)).toBe(true);
    });
    await t.run(async (ctx) => {
      const fnHandle = await createFunctionHandle(
        internal.example.setDefaultValue,
      );
      await runToCompletion(ctx, components.migrations, fnHandle, {
        name: getFunctionName(internal.example.setDefaultValue),
        batchSize: 2,
      });
    });
    await t.run(async (ctx) => {
      const after = await ctx.db.query("myTable").collect();
      expect(after).toHaveLength(10);
      expect(after.every((doc) => doc.optionalField !== undefined)).toBe(true);
    });
  });
});
