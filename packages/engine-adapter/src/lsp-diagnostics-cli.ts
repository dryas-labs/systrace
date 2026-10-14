#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { runDiagnosticsCommand } from "./diagnostics-command.js";
void runDiagnosticsCommand(process.argv.slice(2), {
  input: process.stdin,
  out: (text) => process.stdout.write(text),
  error: (text) => process.stderr.write(text),
}).then((code) => {
  process.exitCode = code;
});
