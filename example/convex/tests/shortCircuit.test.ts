import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "../setup.test";
import { internal } from "../_generated/api";

/**
 * Seed documents that all need migration (optionalField undefined).
 */
async function seedDocs(t: ReturnType<typeof initConvexTest>, count: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("myTable", {
        requiredField: "seed " + i,
        optionalField: undefined,
        unionField: "1",
      });
    }
  });
}

describe("short-circuit with transaction limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("migration short-circuits and completes with tight write limits", async () => {
    // documentsWritten limit of 10:
    // Each batch: component state insert(1) + migration patches + state patch(1)
    // + schedule. With batchSize 5, after ~4 patches: used > remaining,
    // triggering short-circuit. Each scheduled batch gets a fresh budget.
    const t = initConvexTest({ transactionLimits: { documentsWritten: 10 } });
    await seedDocs(t, 10);

    // Start migration via the runner (goes through component for scheduling).
    await t.mutation(internal.tests.shortCircuit.setDefaultValueWithSchema, {
      fn: "example:setDefaultValueWithSchema",
    });

    // Let all scheduled batches run to completion.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify all documents were migrated despite short-circuiting.
    await t.run(async (ctx) => {
      const docs = await ctx.db.query("myTable").collect();
      expect(docs).toHaveLength(10);
      expect(docs.every((d) => d.optionalField !== undefined)).toBe(true);
    });
  });

  test("migration processes full batches when limits are generous", async () => {
    const t = initConvexTest({ transactionLimits: true });
    await seedDocs(t, 10);

    await t.mutation(internal.tests.shortCircuit.setDefaultValueWithSchema, {
      fn: "example:setDefaultValueWithSchema",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      const docs = await ctx.db.query("myTable").collect();
      expect(docs).toHaveLength(10);
      expect(docs.every((d) => d.optionalField !== undefined)).toBe(true);
    });
  });

  test("short-circuit produces partial batch result", async () => {
    // With documentsWritten: 10 and batchSize 10 on 10 docs:
    // After ~5 patches, used(5) > remaining(5) is false, but after
    // patch 6: used(6) > remaining(4) → short-circuit before doc 6.
    const t = initConvexTest({ transactionLimits: { documentsWritten: 10 } });
    await seedDocs(t, 10);

    // Run a single batch directly (not through the component).
    const result = await t.mutation(
      internal.tests.shortCircuit.setDefaultValueWithSchema,
      {
        cursor: null,
        batchSize: 10,
        dryRun: false,
      },
    );

    // Should have short-circuited: processed fewer than 10 docs.
    expect(result.processed).toBeLessThan(10);
    expect(result.processed).toBeGreaterThan(0);
    expect(result.isDone).toBe(false);
    // Cursor should have advanced (paginator gives exact cursor).
    expect(result.continueCursor).not.toBeNull();
  });

  test("short-circuited migration eventually completes all docs", async () => {
    const t = initConvexTest({ transactionLimits: { documentsWritten: 10 } });
    await seedDocs(t, 6);

    // Start and let scheduler finish all batches.
    await t.mutation(internal.tests.shortCircuit.setDefaultValueWithSchema, {
      fn: "example:setDefaultValueWithSchema",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      const docs = await ctx.db.query("myTable").collect();
      expect(docs).toHaveLength(6);
      expect(docs.every((d) => d.optionalField !== undefined)).toBe(true);
    });
  });
});
