---
name: sysml-diagnostics
description: Observe SysML/KerML diagnostics in the current editor window or recompute diagnostics for a saved project or proposed file text.
---

- For red lines or the current Problems panel in VS Code, use the Copilot tool `dryas_editor_diagnostics` (`#systraceProblems`). Its `observation: "editor"` includes unsaved documents and current connection states. A disconnected language service can leave diagnostics in the panel. This tool is available only inside the target editor window; do not substitute another window.
- For saved files, run `dryas-lsp-diagnostics --project <folder>`. This skill also bundles an equivalent entry: `node <skill-directory>/scripts/diagnostics.cjs --project <folder>`. Supply `--lsp <executable>` when it is not on PATH. To check proposed text without writing it, pass `--overlay <project-relative-existing-file>` and supply the text on stdin. `--path` filters output, not the loaded project. The result uses `observation: "lsp-recompute"`.
- Report these as observations. An empty collection is not proof of complete checking. `settled: false` means the command did not meet its quiet-period condition; even `settled: true` does not confirm index completion. Exit 0 can include model errors or an unsettled observation. Both observations use 1-based UTF-16 character positions and remain separate from saved-project API `validate`, whose columns are UTF-8 bytes.
