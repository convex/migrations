#!/usr/bin/env node
/// <reference types="node" />
import { main } from "./cli/main.js";

const exitCode = await main();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
