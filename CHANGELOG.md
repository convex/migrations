# Changelog

## 0.3.8

### Patch Changes

- afe2f81: Fix `Migrations.runner()` so `oneBatchOnly: true` runs only one batch
  without scheduling another batch or the next migration (#74).
- 09cb777: Refresh the start timestamp when restarting a migration after a
  first-batch failure with `reset: true` or an explicit `cursor: null` (#76).

## 0.3.7

- Updates the /test entrypoint for compatibility with convex-test's new
  `defineTestApp` capability.

## 0.3.6

- Before starting a migration, `runOne`, `runSerially`, and the `runner`
  functions now check the migration status from a stale snapshot (via
  `ctx.runQuery(..., { useStaleSnapshot: true })`) and no-op if it's already in
  progress. This avoids OCC conflicts with the batches an in-progress migration
  is actively writing, sometimes caused by re-running post-deploy scripts. If
  `reset` is specified, it does not short-circuit. Requires `convex@^1.42.0`.

## 0.3.5

- Supports running migrations within components by using the convex-helpers
  paginator instead of built-in .paginate
- Stores a `null` cursor when done with a migration.
- Shows the status for the most recent 100 migrations by default, up from 10.

## 0.3.4

- Allows calling migration functions directly to start them, instead of the
  migrations.runner workaround.

## 0.3.3

- Adds a `reset: true` argument to restart all specified migrations

## 0.3.2

- Fixes the cancel functionality for ongoing migrations

## 0.3.1

- Adds `runToCompletion` which can run a migration synchronously from an action,
  stopping if the action times out or fails.

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API
