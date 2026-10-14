#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
void import("../dist/lsp-diagnostics.cjs").catch(() => {
  process.stderr.write(
    "DIAGNOSTICS_UNAVAILABLE: Build the language adapter before running this command.\n",
  );
  process.exitCode = 1;
});
