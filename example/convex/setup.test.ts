/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import localComponentSchema from "./localComponent/schema.js";
import component from "@convex-dev/migrations/test";

const modules = import.meta.glob("./**/*.*s");
const localComponentModules = import.meta.glob("./localComponent/**/*.*s");
// When users want to write tests that use your component, they need to
// explicitly register it with its schema and modules.
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  // The example app also has a local component that installs migrations.
  t.registerComponent(
    "localComponent",
    localComponentSchema,
    localComponentModules,
  );
  component.register(t, "localComponent/migrations");
  return t;
}

test("setup", () => {});
