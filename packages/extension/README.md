# DRYAS Systrace

**English** | [简体中文](README.zh-Hans.md)

SysML v2 editing for VS Code and Cursor, powered by an external OpenSysML engine.
This is an early development extension. View rendering and a built-in agent are future work.

Version 0.1.5 uses OpenSysML `v0.9.2-dryas.4`. Selected completion details show
the native declaration signature, visible reference, actual declaration origin,
source filename and full documentation. Details load on selection and share the
engine's documentation extraction with hover. Aliases retain their insertion
spelling; undocumented elements show their declaration and source only.
Use the details arrow, or Ctrl+Space while the suggestion list is open, to expand
the editor's native detail panel. Update both external engine executables; if
you set `dryas.expectedEngineVersion` explicitly, change it to `v0.9.2-dryas.4`.

See the [engine support policy](../../docs/engine-support.md). The configured DRYAS build is the tested backend; upstream compatibility remains a goal, not a guarantee for arbitrary versions.

## Getting started

1. Build the maintained OpenSysML version described in the repository's `config/engine.json`.
2. Put `sysml-lsp` and `sysml-grpc` on PATH, or set **DRYAS: Lsp Path** and
   **DRYAS: Api Path** in your editor's **User Settings**. Keep machine paths out of committed workspace settings.
3. Open a trusted project folder with SysML/KerML files under `model/`, or configure
   **DRYAS: Model Roots** with the project's source folders.
4. Open a `.sysml` file for diagnostics, completion, hover and definition navigation.

The engine and its standard library are not bundled in this VSIX. Model folders
must contain readable UTF-8 files; symbolic links/junctions are refused in this slice.
Local `selection/` and `designs/` archives must stay outside the configured source folders.

If startup reports `INVALID_PATH during model-folders`, check **DRYAS: Model Roots**
in Workspace Settings (Workspace Folder Settings for a multi-root workspace).
The default `["model"]` requires an existing `model/` directory; folders with other
layouts need explicit paths relative to the opened workspace folder. For example,
when opening `SysML-v2-Release`, use this setting to work on the package lessons:

```json
{
  "dryas.modelRoots": ["sysml/src/training/01. Packages"]
}
```

Choose the source folders belonging to the model you want to edit. Settings changes
automatically retry the connection; after creating a missing directory without changing
settings, run **DRYAS: Restart Language Server**.

F12 on standard-library names such as `ISQ::voltage` opens the bundled source in a
read-only editor. Hover and further definition navigation work inside that editor.
The source is read from the project's running engine; no separate library download
or project copy is needed.
Use ordinary hover to read documentation. Ctrl-hover remains the editor's short
definition-source preview and may show only the beginning of a long doc body.
SysML/KerML default to `editor.wordBasedSuggestions: "off"` so words from open
library documents do not appear as fallback candidates. Native LSP completion
remains enabled; explicit language-specific user settings take precedence.

## Commands

- **DRYAS: Restart Language Server** reloads engine settings and source folders.
- **DRYAS: Show Language Service Status** shows connection state, startup reason,
  attempt count and any startup failure code. The status bar opens this view too.
- **DRYAS: Validate Saved Project** opens a read-only validation result in an untitled document.
- **DRYAS: Show MCP Configuration** opens a local configuration for an external agent.
  That configuration contains runtime paths; keep it out of version control. The MCP CLI needs Node.js 22.13 or later.

Editor diagnostics may include unsaved buffers. MCP and project validation use saved
files across the complete set of model roots. The MCP server provides four read-only tools: `validate`, `find_element`,
`describe_element` and `library_lookup`. The library tool queries the engine’s bundled standard library.

**Connected** means the LSP handshake succeeded. This engine does not announce
index completion, so the extension reports `index: unconfirmed`; cross-file
navigation may still be initializing. This status is separate from model validation.

Configuration edits settle for 750 milliseconds before they are applied. Only
projects with changed effective settings restart. An API-path-only change keeps
the language server connected. A lost connection gets at most one automatic
recovery; use the restart command to retry after that.

The **DRYAS** output channel records startup reasons and distinguishes invalid
path formatting, a missing executable, access failures, version mismatch and
timeouts. In the Settings UI, enter a plain executable path without surrounding
quotes; JSON settings files still require normal JSON quoting and escaping.

Zero errors currently returns `incomplete`: the engine API does not certify complete
validation coverage or library identity. An error-free response is not proof of standards
validity, task correctness or engineering correctness.

## License

DRYAS code is licensed under Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the license text and the notices for bundled JavaScript dependencies.
Legal texts and third-party notices retain their original wording.
