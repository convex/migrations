import type { MigrationStatus } from "../shared.js";

export function logStatusAndInstructions(
  name: string,
  status: MigrationStatus,
  args: {
    fn?: string;
    cursor?: string | null;
    batchSize?: number;
    dryRun?: boolean;
    reset?: boolean;
  },
  migrationsComponent: string,
) {
  const output: Record<string, unknown> = {};
  if (status.isDone) {
    if (status.latestEnd! < Date.now()) {
      output["Status"] = "Migration already done.";
    } else if (status.latestStart === status.latestEnd) {
      output["Status"] = "Migration was started and finished in one batch.";
    } else {
      output["Status"] = "Migration completed with this batch.";
    }
  } else {
    if (status.state === "failed") {
      output["Status"] = `Migration failed: ${status.error}`;
    } else if (status.state === "canceled") {
      output["Status"] = "Migration canceled.";
    } else if (status.latestStart >= Date.now()) {
      output["Status"] = "Migration started.";
    } else {
      output["Status"] = "Migration running.";
    }
  }
  if (args.dryRun) {
    output["DryRun"] = "No changes were committed.";
    output["Status"] = "DRY RUN: " + output["Status"];
  }
  output["Name"] = name;
  output["lastStarted"] = new Date(status.latestStart).toISOString();
  if (status.latestEnd) {
    output["lastFinished"] = new Date(status.latestEnd).toISOString();
  }
  output["processed"] = status.processed;
  if (status.next?.length) {
    if (status.isDone) {
      output["nowUp"] = status.next;
    } else {
      output["nextUp"] = status.next;
    }
  }
  const nextArgs = (status.next || []).map((n) => `"${n}"`).join(", ");
  const run = `npx convex run --component ${migrationsComponent}`;
  if (!args.dryRun) {
    if (status.state === "inProgress") {
      output["toCancel"] = {
        cmd: `${run} lib:cancel`,
        args: `{name: "${name}"}`,
        prod: `--prod`,
      };
      output["toMonitorStatus"] = {
        cmd: `${run} --watch lib:getStatus`,
        args: `{names: ["${name}"${status.next?.length ? ", " + nextArgs : ""}]}`,
        prod: `--prod`,
      };
    } else {
      // Suggest reset: true instead of cursor: null
      const { cursor: _cursor, ...argsWithoutCursor } = args;
      output["toStartOver"] = JSON.stringify({
        ...argsWithoutCursor,
        reset: true,
      });
      if (status.next?.length) {
        output["toMonitorStatus"] = {
          cmd: `${run} --watch lib:getStatus`,
          args: `{names: [${nextArgs}]}`,
          prod: `--prod`,
        };
      }
    }
  }
  return output;
}
