/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import component from "@convex-dev/migrations/test";

const modules = import.meta.glob("./**/*.*s");
// When users want to write tests that use your component, they need to
// explicitly register it with its schema and modules.
export function initConvexTest(opts?: Parameters<typeof convexTest>[0]) {
  const t = convexTest({ ...opts, schema, modules });
  component.register(t);
  return t;
}

test("setup", () => {});
