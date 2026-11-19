import { describe, test, expect } from "vitest";
import { Migrations, DEFAULT_BATCH_SIZE, isNewFormatCursor } from "./index.js";
import type { ComponentApi } from "../component/_generated/component.js";

describe("Migrations class", () => {
  test("can instantiate without error", () => {
    const dummyComponent = {} as ComponentApi;
    expect(() => new Migrations(dummyComponent)).not.toThrow();
  });
});

describe("DEFAULT_BATCH_SIZE", () => {
  test("should equal 100", () => {
    expect(DEFAULT_BATCH_SIZE).toBe(100);
  });
});

describe("isNewFormatCursor", () => {
  test("null cursor returns true (starting fresh)", () => {
    expect(isNewFormatCursor(null)).toBe(true);
  });

  test("new format cursor (JSON array) returns true", () => {
    // Example cursors from convex-helpers paginator
    expect(isNewFormatCursor('["value", 1234567890, "documentId"]')).toBe(true);
    expect(isNewFormatCursor("[]")).toBe(true);
    expect(
      isNewFormatCursor('[1719412234000,"k97d5ycbj3vgwcprmmxvmrm2dh7a5qhv"]'),
    ).toBe(true);
  });

  test("old format cursor (encrypted string) returns false", () => {
    // Example cursors from built-in .paginate() - opaque encrypted strings
    expect(isNewFormatCursor("u1oU8i23WMATVwA2CneZ")).toBe(false);
    expect(isNewFormatCursor("encryptedOpaqueString123")).toBe(false);
    expect(isNewFormatCursor("abc")).toBe(false);
  });

  test("edge cases", () => {
    expect(isNewFormatCursor("")).toBe(false);
    expect(isNewFormatCursor("{}")).toBe(false); // object, not array
    expect(isNewFormatCursor("null")).toBe(false); // string "null"
  });
});
