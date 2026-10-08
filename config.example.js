// SPDX-License-Identifier: Apache-2.0
// Copy this file to config.js. The local copy is ignored by Git.
// Use installed executable paths here; never put machine paths in this template.
export default {
  engine: {
    lspPath: "sysml-lsp",
    apiPath: "sysml-grpc",
  },
  editors: {
    // Empty: download an isolated VS Code test installation.
    vscode: "",
    // Set your installed Cursor executable in config.js to test Cursor.
    cursor: "",
  },
  tests: {
    vscodeVersion: "stable",
  },
};
