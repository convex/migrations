import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defineTestApp } from "convex-test";
import component from "../../src/test.js";
import schema from "./schema.js";
import { migrations } from "./example.js";

const setOptionalField = migrations.define({
  table: "myTable",
  migrateOne: (_ctx, doc) => {
    if (doc.requiredField === "fail") throw new Error("intentional failure");
    return { optionalField: "migrated" };
  },
});

const { internal, createTest } = defineTestApp({ schema }).defineModules({
  fns: { setOptionalField },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

async function failedFirstBatch() {
  const t = createTest();
  component.register(t);
  const id = await t.run((ctx) =>
    ctx.db.insert("myTable", { requiredField: "fail", unionField: "ok" }),
  );
  const run = (options: { reset?: boolean; cursor?: string | null } = {}) =>
    t.run((ctx) =>
      migrations.runOne(ctx, internal.fns.setOptionalField, options),
    );
  const status = async () =>
    (
      await t.run((ctx) =>
        migrations.getStatus(ctx, {
          migrations: [internal.fns.setOptionalField],
        }),
      )
    )[0];
  const row = () => t.run((ctx) => ctx.db.get("myTable", id));

  expect(await run()).toMatchObject({
    state: "failed",
    cursor: null,
    processed: 0,
    latestStart: 1000,
    isDone: false,
  });
  expect((await row())?.optionalField).toBeUndefined();
  await t.run((ctx) => ctx.db.patch("myTable", id, { requiredField: "ok" }));
  vi.setSystemTime(2000);
  return { run, status, row };
}

test.each([
  { label: "reset:true", options: { reset: true } },
  { label: "cursor:null", options: { cursor: null } },
])(
  "explicit $label after first-batch failure refreshes latestStart",
  async ({ options }) => {
    const f = await failedFirstBatch();
    const result = await f.run(options);
    expect((await f.row())?.optionalField).toBe("migrated");
    expect(await f.status()).toEqual(result);
    expect(result).toMatchObject({
      state: "success",
      isDone: true,
      processed: 1,
      latestStart: 2000,
    });
  },
);

test("ordinary resume after first-batch failure preserves latestStart", async () => {
  const f = await failedFirstBatch();
  const result = await f.run();
  expect(result).toMatchObject({
    state: "success",
    isDone: true,
    processed: 1,
    latestStart: 1000,
  });
  expect(await f.status()).toEqual(result);
  expect((await f.row())?.optionalField).toBe("migrated");
});
