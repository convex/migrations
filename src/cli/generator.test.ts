import { describe, expect, test } from "vitest";
import {
  renderMigrationFile,
  renderRenameFieldMigration,
  renderRenameTableMigration,
} from "./generator.js";

describe("migration scaffold generator", () => {
  test("renders rename-field migration contents", () => {
    const migration = renderRenameFieldMigration({
      table: "users",
      oldField: "oldName",
      newField: "newName",
    });

    expect(migration.name).toBe("renameUsersOldNameToNewName");
    expect(renderMigrationFile(migration.definition)).toBe(`import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import schema from "./schema.js";

export const migrations = new Migrations(components.migrations, {
  internalMutation,
  schema,
});

export const renameUsersOldNameToNewName = migrations.define({
  table: "users",
  migrateOne: (_ctx, doc) => {
    if (doc.oldName === undefined) {
      return;
    }
    return {
      newName: doc.oldName,
      oldName: undefined,
    };
  },
});
`);
  });

  test("renders rename-table migration contents", () => {
    const migration = renderRenameTableMigration({
      oldTable: "oldUsers",
      newTable: "users",
    });

    expect(migration.name).toBe("renameOldUsersToUsers");
    expect(renderMigrationFile(migration.definition)).toBe(`import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import schema from "./schema.js";

export const migrations = new Migrations(components.migrations, {
  internalMutation,
  schema,
});

export const renameOldUsersToUsers = migrations.define({
  table: "oldUsers",
  migrateOne: async (ctx, doc) => {
    // Copying gives each document a new _id. Update any v.id("oldUsers")
    // references in other tables, or they will point at deleted documents.
    const { _id: oldId, _creationTime: _oldCreationTime, ...newDoc } = doc;
    await ctx.db.insert("users", newDoc);
    await ctx.db.delete(oldId);
  },
});
`);
  });
});
