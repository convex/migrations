import { type Infer, type ObjectType, v } from "convex/values";

export const migrationArgs = {
  fn: v.optional(v.string()),
  cursor: v.optional(v.union(v.string(), v.null())),
  batchSize: v.optional(v.number()),
  dryRun: v.optional(v.boolean()),
  next: v.optional(v.array(v.string())),
  reset: v.optional(v.boolean()),
  oneBatchOnly: v.optional(v.boolean()),
};
export type MigrationArgs = ObjectType<typeof migrationArgs>;

/**
 * Args validator for a migration function. Use it to write a custom migration
 * mutation that can be passed to `runner`, `runOne` or `runSerially`.
 */
export const vMigrationArgs = v.object(migrationArgs);

/**
 * Returns validator for a migration function. Each call processes one batch
 * and reports where to continue from and whether the migration is done.
 */
export const vMigrationReturns = v.object({
  continueCursor: v.string(),
  isDone: v.boolean(),
  processed: v.number(),
});
export type MigrationResult = Infer<typeof vMigrationReturns>;

export const migrationStatus = v.object({
  name: v.string(),
  cursor: v.optional(v.union(v.string(), v.null())),
  processed: v.number(),
  isDone: v.boolean(),
  error: v.optional(v.string()),
  state: v.union(
    v.literal("inProgress"),
    v.literal("success"),
    v.literal("failed"),
    v.literal("canceled"),
    v.literal("unknown"),
  ),
  latestStart: v.number(),
  latestEnd: v.optional(v.number()),
  batchSize: v.optional(v.number()),
  next: v.optional(v.array(v.string())),
});
export type MigrationStatus = Infer<typeof migrationStatus>;
