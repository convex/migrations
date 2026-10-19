import { Migrations } from "@convex-dev/migrations";
import { components } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import schema from "../schema";

export const migrationsWithSchema = new Migrations(components.migrations, {
  internalMutation,
  schema,
});

// Migration with schema (uses paginator for exact short-circuit cursors).
export const setDefaultValueWithSchema = migrationsWithSchema.define({
  table: "myTable",
  batchSize: 10,
  migrateOne: async (_ctx, doc) => {
    if (doc.optionalField === undefined) {
      return { optionalField: "default" };
    }
  },
});
