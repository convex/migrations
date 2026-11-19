import { type Infer, v } from "convex/values";

/** Args validator for migration functions. */
export const vMigrationArgs = v.object({
  fn: v.optional(v.string()),
  cursor: v.optional(v.union(v.string(), v.null())),
  batchSize: v.optional(v.number()),
  dryRun: v.optional(v.boolean()),
  next: v.optional(v.array(v.string())),
  reset: v.optional(v.boolean()),
  oneBatchOnly: v.optional(v.boolean()),
});
export type MigrationArgs = Infer<typeof vMigrationArgs>;

export type MigrationResult = {
  continueCursor: string;
  isDone: boolean;
  processed: number;
};

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
