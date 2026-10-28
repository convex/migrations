export type RenameFieldSpec = {
  table: string;
  oldField: string;
  newField: string;
  name?: string;
};

export type RenameTableSpec = {
  oldTable: string;
  newTable: string;
  name?: string;
};

export type CustomMigrationSpec = {
  table: string;
  name?: string;
};

export type GeneratedMigration = {
  name: string;
  operation: "renameField" | "renameTable" | "custom";
  definition: string;
};

const reservedWords = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function parseRenameFieldSpec(input: string): RenameFieldSpec {
  const match = input.trim().match(/^([^.=]+)\.([^.=]+)=([^=]+)$/);
  if (!match) {
    throw new Error(
      `Expected --rename-field in the form table.oldField=newField, got ${JSON.stringify(input)}`,
    );
  }
  return {
    table: requireValue(match[1], "table"),
    oldField: requireValue(match[2], "old field"),
    newField: requireValue(match[3], "new field"),
  };
}

export function parseRenameTableSpec(input: string): RenameTableSpec {
  const match = input.trim().match(/^([^=]+)=([^=]+)$/);
  if (!match) {
    throw new Error(
      `Expected --rename-table in the form oldTable=newTable, got ${JSON.stringify(input)}`,
    );
  }
  return {
    oldTable: requireValue(match[1], "old table"),
    newTable: requireValue(match[2], "new table"),
  };
}

export function renderRenameFieldMigration(
  spec: RenameFieldSpec,
): GeneratedMigration {
  const table = requireValue(spec.table, "table");
  const oldField = requireValue(spec.oldField, "old field");
  const newField = requireValue(spec.newField, "new field");
  if (oldField === newField) {
    throw new Error("Old and new field names must be different");
  }
  const name =
    spec.name ??
    toExportName(
      `rename${toPascalCase(table)}${toPascalCase(oldField)}To${toPascalCase(
        newField,
      )}`,
    );
  const oldRead = fieldRead("doc", oldField);
  const definition = `export const ${toExportName(name)} = migrations.define({
  table: ${quote(table)},
  migrateOne: (_ctx, doc) => {
    if (${oldRead} === undefined) {
      return;
    }
    return {
      ${fieldKey(newField)}: ${oldRead},
      ${fieldKey(oldField)}: undefined,
    };
  },
});`;
  return { name: toExportName(name), operation: "renameField", definition };
}

export function renderRenameTableMigration(
  spec: RenameTableSpec,
): GeneratedMigration {
  const oldTable = requireValue(spec.oldTable, "old table");
  const newTable = requireValue(spec.newTable, "new table");
  if (oldTable === newTable) {
    throw new Error("Old and new table names must be different");
  }
  const name =
    spec.name ??
    toExportName(
      `rename${toPascalCase(oldTable)}To${toPascalCase(newTable)}`,
    );
  const definition = `export const ${toExportName(name)} = migrations.define({
  table: ${quote(oldTable)},
  migrateOne: async (ctx, doc) => {
    // Copying gives each document a new _id. Update any v.id(${quote(oldTable)})
    // references in other tables, or they will point at deleted documents.
    const { _id: oldId, _creationTime: _oldCreationTime, ...newDoc } = doc;
    await ctx.db.insert(${quote(newTable)}, newDoc);
    await ctx.db.delete(oldId);
  },
});`;
  return { name: toExportName(name), operation: "renameTable", definition };
}

export function renderCustomMigration(
  spec: CustomMigrationSpec,
): GeneratedMigration {
  const table = requireValue(spec.table, "table");
  const name = toExportName(spec.name ?? `migrate${toPascalCase(table)}`);
  const definition = `export const ${name} = migrations.define({
  table: ${quote(table)},
  migrateOne: async (_ctx, _doc) => {
  },
});`;
  return { name, operation: "custom", definition };
}

export function renderMigrationFile(definition: string): string {
  return `import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import schema from "./schema.js";

export const migrations = new Migrations(components.migrations, {
  internalMutation,
  schema,
});

${definition}
`;
}

export function toExportName(input: string): string {
  const trimmed = input.trim();
  if (identifierPattern.test(trimmed) && !reservedWords.has(trimmed)) {
    return trimmed;
  }
  const fallback = lowerFirst(toPascalCase(trimmed));
  if (identifierPattern.test(fallback) && !reservedWords.has(fallback)) {
    return fallback;
  }
  return `migration${toPascalCase(trimmed)}`;
}

function requireValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing ${label}`);
  }
  return trimmed;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fieldRead(base: string, field: string): string {
  return identifierPattern.test(field)
    ? `${base}.${field}`
    : `${base}[${quote(field)}]`;
}

function fieldKey(field: string): string {
  return identifierPattern.test(field) ? field : `[${quote(field)}]`;
}

function toPascalCase(input: string): string {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const pascal = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return pascal || "Migration";
}

function lowerFirst(input: string): string {
  return input.charAt(0).toLowerCase() + input.slice(1);
}
