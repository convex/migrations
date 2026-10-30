/// <reference types="node" />
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  type CustomMigrationSpec,
  type GeneratedMigration,
  type RenameFieldSpec,
  type RenameTableSpec,
  parseRenameFieldSpec,
  parseRenameTableSpec,
  renderCustomMigration,
  renderMigrationFile,
  renderRenameFieldMigration,
  renderRenameTableMigration,
  toExportName,
} from "./generator.js";

type CliIO = {
  cwd: string;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
};

type ParsedArgs = {
  command?: string;
  help: boolean;
  json: boolean;
  name?: string;
  renameField?: string;
  renameTable?: string;
};

type ComponentState = {
  installed: boolean;
  configPath?: string;
};

type CreateMigrationResult = {
  path: string;
  migration: string;
  operation: GeneratedMigration["operation"];
  action: "created" | "updated";
  componentInstalled: boolean;
  setupRequired: boolean;
  run: string;
  setupSteps?: string;
};

const setupSteps = `Install and configure the migrations component:

  npm install @convex-dev/migrations

Create convex/convex.config.ts if it does not exist, then add:

  import { defineApp } from "convex/server";
  import migrations from "@convex-dev/migrations/convex.config.js";

  const app = defineApp();
  app.use(migrations);

  export default app;`;

export async function main(
  args = process.argv.slice(2),
  io: CliIO = {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    writeLine(io.stderr, errorMessage(error));
    writeLine(io.stderr, "");
    writeLine(io.stderr, helpText());
    return 1;
  }

  if (parsed.help || !parsed.command) {
    writeLine(io.stdout, helpText());
    return 0;
  }

  if (parsed.command !== "create") {
    writeLine(io.stderr, `Unknown command ${JSON.stringify(parsed.command)}`);
    writeLine(io.stderr, "");
    writeLine(io.stderr, helpText());
    return 1;
  }

  try {
    const request = await buildCreateRequest(parsed, io);
    const result = await createMigration(request, io.cwd);
    if (parsed.json) {
      writeLine(io.stdout, JSON.stringify(result, null, 2));
    } else {
      if (result.setupRequired) {
        writeLine(io.stderr, "");
        writeLine(io.stderr, setupSteps);
        writeLine(io.stderr, "");
      }
      writeLine(
        io.stdout,
        `${capitalize(result.action)} ${result.path} with ${result.migration}`,
      );
      writeLine(io.stdout, `Run it with: ${result.run}`);
    }
    return 0;
  } catch (error) {
    if (parsed.json) {
      writeLine(
        io.stdout,
        JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2),
      );
    } else {
      writeLine(io.stderr, errorMessage(error));
    }
    return 1;
  }
}

async function createMigration(
  migration: GeneratedMigration,
  cwd: string,
): Promise<CreateMigrationResult> {
  const convexDir = path.join(cwd, "convex");
  const dirStat = await stat(convexDir).catch(() => undefined);
  if (!dirStat?.isDirectory()) {
    throw new Error(
      "Could not find a convex/ directory. Run this command from the root of a Convex app.",
    );
  }

  const filePath = path.join(convexDir, "migrations.ts");
  const relativePath = path.relative(cwd, filePath);
  const componentState = await detectComponentState(cwd);
  const fileExists = await exists(filePath);
  let action: "created" | "updated";

  if (fileExists) {
    const current = await readFile(filePath, "utf8");
    if (hasExport(current, migration.name)) {
      throw new Error(`${relativePath} already exports ${migration.name}`);
    }
    if (!current.includes("new Migrations(")) {
      throw new Error(
        `${relativePath} exists, but it does not initialize @convex-dev/migrations. Add the Migrations setup from the README before appending generated migrations.`,
      );
    }
    await appendFile(
      filePath,
      appendBlock(current, migration.definition),
      "utf8",
    );
    action = "updated";
  } else {
    await mkdir(convexDir, { recursive: true });
    await writeFile(filePath, renderMigrationFile(migration.definition), "utf8");
    action = "created";
  }

  return {
    path: relativePath,
    migration: migration.name,
    operation: migration.operation,
    action,
    componentInstalled: componentState.installed,
    setupRequired: !componentState.installed,
    run: `npx convex run migrations:${migration.name}`,
    setupSteps: componentState.installed ? undefined : setupSteps,
  };
}

async function buildCreateRequest(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<GeneratedMigration> {
  if (parsed.renameField && parsed.renameTable) {
    throw new Error("Specify only one of --rename-field or --rename-table");
  }

  if (parsed.renameField) {
    const spec = parseRenameFieldSpec(parsed.renameField);
    return renderRenameFieldMigration({ ...spec, name: parsed.name });
  }
  if (parsed.renameTable) {
    const spec = parseRenameTableSpec(parsed.renameTable);
    return renderRenameTableMigration({ ...spec, name: parsed.name });
  }

  if (!io.stdin.isTTY) {
    throw new Error(
      "Missing migration type. Pass --rename-field table.old=new or --rename-table old=new, or run in an interactive terminal.",
    );
  }

  return promptForMigration(parsed.name, io);
}

async function promptForMigration(
  name: string | undefined,
  io: CliIO,
): Promise<GeneratedMigration> {
  const rl = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const kindAnswer = await rl.question(
      "Migration type [rename-field, rename-table, custom] (rename-field): ",
    );
    const kind = normalizeKind(kindAnswer || "rename-field");
    if (kind === "rename-field") {
      const answer = await rl.question(
        "Field rename (table.oldField=newField): ",
      );
      const spec: RenameFieldSpec = parseRenameFieldSpec(answer);
      return renderRenameFieldMigration({
        ...spec,
        name: await promptName(rl, name, () =>
          renderRenameFieldMigration(spec).name,
        ),
      });
    }
    if (kind === "rename-table") {
      const answer = await rl.question("Table rename (oldTable=newTable): ");
      const spec: RenameTableSpec = parseRenameTableSpec(answer);
      return renderRenameTableMigration({
        ...spec,
        name: await promptName(rl, name, () =>
          renderRenameTableMigration(spec).name,
        ),
      });
    }
    const table = await rl.question("Table to migrate: ");
    const spec: CustomMigrationSpec = { table };
    return renderCustomMigration({
      ...spec,
      name: await promptName(rl, name, () => renderCustomMigration(spec).name),
    });
  } finally {
    rl.close();
  }
}

async function promptName(
  rl: ReturnType<typeof createInterface>,
  provided: string | undefined,
  defaultName: () => string,
): Promise<string> {
  if (provided) {
    return toExportName(provided);
  }
  const fallback = defaultName();
  const answer = await rl.question(`Export name (${fallback}): `);
  return toExportName(answer || fallback);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, json: false };
  const rest = [...args];
  if (rest[0] && !rest[0].startsWith("-")) {
    parsed.command = rest.shift();
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--rename-field") {
      parsed.renameField = takeValue(rest, i, arg);
      i += 1;
    } else if (arg.startsWith("--rename-field=")) {
      parsed.renameField = arg.slice("--rename-field=".length);
    } else if (arg === "--rename-table") {
      parsed.renameTable = takeValue(rest, i, arg);
      i += 1;
    } else if (arg.startsWith("--rename-table=")) {
      parsed.renameTable = arg.slice("--rename-table=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}`);
    } else if (!parsed.name) {
      parsed.name = arg;
    } else {
      throw new Error(`Unexpected argument ${arg}`);
    }
  }
  return parsed;
}

async function detectComponentState(cwd: string): Promise<ComponentState> {
  const candidates = [
    path.join(cwd, "convex", "convex.config.ts"),
    path.join(cwd, "convex", "convex.config.js"),
    path.join(cwd, "convex", "convex.config.mts"),
    path.join(cwd, "convex", "convex.config.mjs"),
  ];
  for (const configPath of candidates) {
    if (!(await exists(configPath))) {
      continue;
    }
    const contents = await readFile(configPath, "utf8");
    return {
      configPath,
      installed:
        contents.includes("@convex-dev/migrations/convex.config") ||
        /app\.use\(\s*migrations\s*\)/.test(contents),
    };
  }
  return { installed: false };
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath, constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

function appendBlock(current: string, block: string): string {
  const separator = current.endsWith("\n\n")
    ? ""
    : current.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${separator}${block}\n`;
}

function hasExport(contents: string, name: string): boolean {
  return new RegExp(`\\bexport\\s+const\\s+${escapeRegExp(name)}\\b`).test(
    contents,
  );
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function normalizeKind(
  kind: string,
): "rename-field" | "rename-table" | "custom" {
  const normalized = kind.trim().toLowerCase();
  if (
    normalized === "rename-field" ||
    normalized === "field" ||
    normalized === "rename field"
  ) {
    return "rename-field";
  }
  if (
    normalized === "rename-table" ||
    normalized === "table" ||
    normalized === "rename table"
  ) {
    return "rename-table";
  }
  if (normalized === "custom" || normalized === "blank") {
    return "custom";
  }
  throw new Error(`Unknown migration type ${JSON.stringify(kind)}`);
}

function helpText(): string {
  return `Usage:
  convex-migrations create [name] [--rename-field table.oldField=newField]
  convex-migrations create [name] [--rename-table oldTable=newTable]

Options:
  --rename-field <table.old=new>  Scaffold a field rename migration
  --rename-table <old=new>        Scaffold a table rename migration
  --json                          Print a JSON success summary
  -h, --help                      Show this help`;
}

function writeLine(stream: Writable, text: string): void {
  stream.write(`${text}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
