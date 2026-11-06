import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import component from "@convex-dev/migrations/test";
import { initConvexTest } from "../setup.test";
import { components, internal } from "../_generated/api";

// The local component's generated ComponentApi is empty, so spell out the
// functions we call on it here.
const localComponent = components.localComponent as unknown as {
  example: {
    seed: FunctionReference<"mutation", "internal", Record<string, never>>;
    addDefaultValue: FunctionReference<
      "mutation",
      "internal",
      { batchSize?: number }
    >;
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("instructions use the app's migrations component", async () => {
  const t = initConvexTest();
  await t.run(async (ctx) => {
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert("myTable", {
        requiredField: "seed " + i,
        unionField: "1",
      });
    }
  });
  const result = (await t.mutation(internal.example.setDefaultValue, {
    batchSize: 2,
  })) as Record<string, any>;
  expect(result.toCancel.cmd).toEqual(
    "npx convex run --component migrations lib:cancel",
  );
  expect(result.toMonitorStatus.cmd).toEqual(
    "npx convex run --component migrations --watch lib:getStatus",
  );
});

test("instructions are prefixed with the enclosing component's path", async () => {
  const t = initConvexTest();
  await t.mutation(localComponent.example.seed, {});
  const result = (await t.mutation(localComponent.example.addDefaultValue, {
    batchSize: 2,
  })) as Record<string, any>;
  expect(result.toCancel.cmd).toEqual(
    "npx convex run --component localComponent/migrations lib:cancel",
  );
  expect(result.toMonitorStatus.cmd).toEqual(
    "npx convex run --component localComponent/migrations --watch lib:getStatus",
  );
});

test("the component reports the name it was mounted as", async () => {
  const t = initConvexTest();
  const dbMigrations = component.register(t, "dbMigrations");
  expect(await t.query(dbMigrations.lib.componentPath, {})).toEqual(
    "dbMigrations",
  );
});
