import { Migrations, type MigrationStatus } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import schema from "./schema.js";

export const migrations = new Migrations(components.migrations, {
  internalMutation,
  schema,
});

export const setDefaultValue = migrations.define({
  table: "myTable",
  batchSize: 2,
  migrateOne: async (_ctx, doc) => {
    if (doc.optionalField === undefined) {
      return { optionalField: "default" };
    }
  },
  parallelize: true,
});

export const clearField = migrations.define({
  table: "myTable",
  migrateOne: () => ({ optionalField: undefined }),
});

export const validateRequiredField = migrations.define({
  table: "myTable",
  // Specify a custom range to only include documents that need to change.
  // This is useful if you have a large dataset and only a small percentage of
  // documents need to be migrated.
  customRange: (query) =>
    query.withIndex("by_requiredField", (q) => q.eq("requiredField", "")),
  migrateOne: async (_ctx, doc) => {
    console.log("Needs fixup: " + doc._id);
    // Shorthand for patching
    return { requiredField: "<unknown>" };
  },
});

// If you prefer the old-style migration definition, you can define `migration`:
const migration = migrations.define.bind(migrations);
// Then use it like this:
export const convertUnionField = migration({
  table: "myTable",
  migrateOne: async (ctx, doc) => {
    if (typeof doc.unionField === "number") {
      await ctx.db.patch("myTable", doc._id, {
        unionField: doc.unionField.toString(),
      });
    }
  },
});

export const failingMigration = migrations.define({
  table: "myTable",
  batchSize: 1,
  migrateOne: async (ctx, doc) => {
    if (doc._id !== (await ctx.db.query("myTable").first())?._id) {
      throw new Error("This migration fails after the first");
    }
  },
});

export const runOneAtATime = internalMutation({
  args: {},
  handler: async (ctx) => {
    await migrations.runOne(ctx, internal.example.failingMigration, {
      batchSize: 1,
    });
  },
});

// It's handy to have a list of all migrations that folks should run in order.
const allMigrations = [
  internal.example.setDefaultValue,
  internal.example.validateRequiredField,
  internal.example.convertUnionField,
  internal.example.failingMigration,
];

export const runAll = migrations.runner(allMigrations);

// Call this from a deploy script to run them after pushing code.
export const postDeploy = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Do other post-deploy things...
    await migrations.runSerially(ctx, allMigrations);
  },
});

// Handy for checking the status from the CLI / dashboard.
export const getStatus = internalQuery({
  args: {},
  handler: async (ctx): Promise<MigrationStatus[]> => {
    return migrations.getStatus(ctx, {
      migrations: allMigrations,
    });
  },
});

export const cancel = internalMutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.name) {
      await migrations.cancel(ctx, args.name);
    } else {
      await migrations.cancelAll(ctx);
    }
  },
});

export const seed = internalMutation({
  args: { count: v.optional(v.number()) },
  handler: async (ctx, args) => {
    for (let i = 0; i < (args.count ?? 10); i++) {
      await ctx.db.insert("myTable", {
        requiredField: "seed " + i,
        optionalField: i % 2 ? "optionalValue" : undefined,
        unionField: i % 2 ? "1" : 1,
      });
    }
  },
});
