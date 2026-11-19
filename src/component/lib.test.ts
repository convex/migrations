import { defineTestApp } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { MigrationResult } from "../client/index.js";
import { vMigrationArgs } from "../shared.js";
import * as lib from "./lib.js";
import schema from "./schema.js";

const app = defineTestApp({ schema });
const { api, createTest } = app.defineModules({
  lib,
  fns: {
    doneMigration: app.mutation({
      args: vMigrationArgs,
      handler: async (): Promise<MigrationResult> => {
        return {
          isDone: true,
          continueCursor: "foo",
          processed: 1,
        };
      },
    }),
    doneMigration2: app.mutation({
      args: vMigrationArgs,
      handler: async (): Promise<MigrationResult> => {
        return {
          isDone: true,
          continueCursor: "bar",
          processed: 2,
        };
      },
    }),
    inProgressMigration: app.mutation({
      args: vMigrationArgs,
      handler: async (): Promise<MigrationResult> => {
        // Simulates a migration that processes 10 items and needs to continue
        return {
          isDone: false,
          continueCursor: "cursor_after_10",
          processed: 10,
        };
      },
    }),
  },
});

describe("migrate", () => {
  test("runs a simple migration in one go", async () => {
    const t = createTest();
    const fnHandle = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );
    const result = await t.mutation(api.lib.migrate, {
      name: "testMigration",
      fnHandle: fnHandle,
      dryRun: false,
    });
    expect(result.isDone).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.batchSize).toBeUndefined();
    expect(result.next).toBeUndefined();
    expect(result.latestEnd).toBeTypeOf("number");
    expect(result.state).toBe("success");
  });

  test("throws error for batchSize <= 0", async () => {
    const args = {
      name: "testMigration",
      fnHandle: "function://dummy",
      cursor: null,
      batchSize: 0,
      next: [],
      dryRun: false,
    };
    const t = createTest();
    // Assumes testApi has shape matching api.lib – adjust per actual ConvexTest usage
    await expect(t.mutation(api.lib.migrate, args)).rejects.toThrow(
      "Batch size must be greater than 0",
    );
  });

  test("throws error for invalid fnHandle", async () => {
    const args = {
      name: "testMigration",
      fnHandle: "invalid_handle",
      cursor: null,
      batchSize: 10,
      next: [],
      dryRun: false,
    };
    const t = createTest();
    await expect(t.mutation(api.lib.migrate, args)).rejects.toThrow(
      "Invalid fnHandle",
    );
  });
});

describe("cancel", () => {
  test("throws error if migration not found", async () => {
    // For cancel, ConvexTest-like patterns would be similar – this code demonstrates minimal direct call
    const t = createTest();
    await expect(
      t.mutation(api.lib.cancel, { name: "nonexistent" }),
    ).rejects.toThrow();
  });

  test("cancel calls scheduler.cancel when workerId exists", async () => {
    const t = createTest();
    const fnHandle = await t.run(() =>
      createFunctionHandle(api.fns.inProgressMigration),
    );

    // Start migration with oneBatchOnly=false so it schedules next batch
    const result = await t.mutation(api.lib.migrate, {
      name: "testCancelMigration",
      fnHandle: fnHandle,
      dryRun: false,
      oneBatchOnly: false,
    });

    expect(result.state).toBe("inProgress");
    expect(result.isDone).toBe(false);

    // Cancel it
    const cancelResult = await t.mutation(api.lib.cancel, {
      name: "testCancelMigration",
    });
    expect(cancelResult.state).toBe("canceled");

    // Verify getStatus also shows canceled
    const status = await t.query(api.lib.getStatus, {
      names: ["testCancelMigration"],
    });
    expect(status[0]?.state).toBe("canceled");
  });

  test("canceled migration can be restarted", async () => {
    const t = createTest();
    const fnHandle = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );

    // Create a migration with a canceled scheduled function
    await t.run(async (ctx) => {
      const workerId = await ctx.scheduler.runAfter(
        0,
        api.fns.doneMigration,
        {},
      );
      await ctx.scheduler.cancel(workerId);
      await ctx.db.insert("migrations", {
        name: "testRestartCanceled",
        latestStart: Date.now(),
        workerId,
        isDone: false,
        cursor: "old_cursor",
        processed: 25,
      });
      const [status] = await ctx.runQuery(api.lib.getStatus, {
        names: ["testRestartCanceled"],
      });
      expect(status?.state).toBe("canceled");
    });

    // Restart without a cursor
    const result = await t.mutation(api.lib.migrate, {
      name: "testRestartCanceled",
      fnHandle: fnHandle,
      dryRun: false,
    });

    expect(result.state).toBe("success");
    expect(result.isDone).toBe(true);
  });
});

describe("It doesn't attempt a migration if it's already done", () => {
  test("runs a simple migration in one go", async () => {
    const t = createTest();
    const fnHandle = "function://invalid";
    await t.run((ctx) =>
      ctx.db.insert("migrations", {
        name: "testMigration",
        latestStart: Date.now(),
        isDone: true,
        cursor: "foo",
        processed: 1,
      }),
    );
    // It'd throw if it tried to run the migration.
    const result = await t.mutation(api.lib.migrate, {
      name: "testMigration",
      fnHandle: fnHandle,
      dryRun: false,
    });
    expect(result.isDone).toBe(true);
  });
});

describe("reset", () => {
  test("reset re-runs a migration that was already done", async () => {
    const t = createTest();
    const fnHandle = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );
    // Pre-seed a completed migration
    await t.run((ctx) =>
      ctx.db.insert("migrations", {
        name: "testMigration",
        latestStart: Date.now(),
        isDone: true,
        cursor: "oldCursor",
        processed: 5,
      }),
    );
    // Without reset, it would skip (already done). With reset + cursor: null,
    // it should re-run from the beginning.
    const result = await t.mutation(api.lib.migrate, {
      name: "testMigration",
      fnHandle,
      cursor: null,
      reset: true,
      dryRun: false,
    });
    expect(result.isDone).toBe(true);
    // processed is reset to 0 then incremented by 1 from doneMigration
    expect(result.processed).toBe(1);
    expect(result.state).toBe("success");
  });

  test("reset with cursor: null restarts from beginning", async () => {
    const t = createTest();
    const fnHandle = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );
    // Pre-seed a migration that was in progress (not done)
    await t.run((ctx) =>
      ctx.db.insert("migrations", {
        name: "testMigration",
        latestStart: Date.now(),
        isDone: false,
        cursor: "someCursor",
        processed: 50,
      }),
    );
    const result = await t.mutation(api.lib.migrate, {
      name: "testMigration",
      fnHandle,
      cursor: null,
      reset: true,
      dryRun: false,
    });
    expect(result.isDone).toBe(true);
    // processed should be reset: 0 + 1 from the migration run
    expect(result.processed).toBe(1);
  });

  test("reset propagates to next migrations in a series", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const fnHandle1 = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );
    const fnHandle2 = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration2),
    );
    // Pre-seed both migrations as completed
    await t.run(async (ctx) => {
      await ctx.db.insert("migrations", {
        name: "migration1",
        latestStart: Date.now(),
        isDone: true,
        cursor: "cursor1",
        processed: 10,
      });
      await ctx.db.insert("migrations", {
        name: "migration2",
        latestStart: Date.now(),
        isDone: true,
        cursor: "cursor2",
        processed: 20,
      });
    });
    // Run migration1 with reset and a next migration
    const result = await t.mutation(api.lib.migrate, {
      name: "migration1",
      fnHandle: fnHandle1,
      cursor: null,
      reset: true,
      next: [{ name: "migration2", fnHandle: fnHandle2 }],
      dryRun: false,
    });
    expect(result.isDone).toBe(true);
    expect(result.processed).toBe(1);

    // The next migration should have been scheduled with reset: true.
    // Run the scheduled functions to verify it actually runs migration2.
    // finishAllScheduledFunctions runs all scheduled functions including
    // those scheduled by scheduled functions.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Check migration2 state was reset and re-run
    const statuses = await t.query(api.lib.getStatus, {
      names: ["migration2"],
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.isDone).toBe(true);
    // migration2 ran with reset, so processed should be fresh (2 from doneMigration2)
    expect(statuses[0]!.processed).toBe(2);
    vi.useRealTimers();
  });

  test("without reset, already-done next migrations are skipped", async () => {
    const t = createTest();
    const fnHandle1 = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );
    const fnHandle2 = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration2),
    );
    // Pre-seed migration2 as completed
    await t.run(async (ctx) => {
      await ctx.db.insert("migrations", {
        name: "migration2",
        latestStart: Date.now(),
        isDone: true,
        cursor: null,
        processed: 20,
      });
    });
    // Run migration1 WITHOUT reset, with next pointing to already-done migration2
    const result = await t.mutation(api.lib.migrate, {
      name: "migration1",
      fnHandle: fnHandle1,
      next: [{ name: "migration2", fnHandle: fnHandle2 }],
      dryRun: false,
    });
    expect(result.isDone).toBe(true);

    await t.finishInProgressScheduledFunctions();

    // migration2 should remain unchanged (not re-run)
    const statuses = await t.query(api.lib.getStatus, {
      names: ["migration2"],
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.processed).toBe(20);
    expect(statuses[0]!.cursor).toBe(null);
  });

  test("reset on a fresh migration (no prior state) works", async () => {
    const t = createTest();
    const fnHandle = await t.run(() =>
      createFunctionHandle(api.fns.doneMigration),
    );
    // No pre-seeded state — reset on a brand new migration
    const result = await t.mutation(api.lib.migrate, {
      name: "freshMigration",
      fnHandle,
      cursor: null,
      reset: true,
      dryRun: false,
    });
    expect(result.isDone).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.state).toBe("success");
  });
});
