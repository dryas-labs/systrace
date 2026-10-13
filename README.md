# Systrace

**English** | [简体中文](README.zh-Hans.md)

Systrace supports systems engineering modeling and the engineering digital thread.
The product is a VS Code extension, also tested in Cursor. It uses a language engine
for SysML v2 editing and an MCP server to connect external agents.

This development version provides LSP integration and four read-only MCP tools: `validate`, `find_element`, `describe_element`, `library_lookup`. Validation and project queries use saved files. View rendering and a built-in agent are not implemented. These tools do not establish engineering correctness or full standards conformance.

## Start developing

Install Node.js 22.13 or later (24 LTS recommended) and npm.

```sh
npm ci
npm run config:init
```

Edit the generated **`config.js`** with the locations of your language engine executables.
Git ignores this file; do not commit it. The tracked [config.example.js](config.example.js)
provides generic defaults and field descriptions. `config.js` is trusted local
JavaScript configuration for this repository's development scripts. It is not
automatically executed from an opened model project.

```sh
npm run check
npm run package:vsix
```

The VSIX is written to `artifacts/`. In VS Code or Cursor, run **Extensions: Install from VSIX...** to install it. Editor launch configurations and example projects are not included in this repository.

See [Language engine](docs/language-engine.md) for the current selection.

## Language engine

[config/engine.json](config/engine.json) records the development engine version and
source commit. This VSIX uses external `sysml-lsp` and `sysml-grpc` executables;
it does not bundle the engine or its standard library.

Version 0.1.8 uses `v0.9.2-dryas.5`. Selected completion details show the native
declaration, reference spelling, actual declaration origin, source filename and
complete `doc`. Update the VSIX and both external executables together. If you
set `dryas.expectedEngineVersion` explicitly, update it to `v0.9.2-dryas.5` too.
With the build toolchain required by the configured language engine installed, run:

```sh
node scripts/build-engine.mjs
```

The script retrieves and builds the selected maintained version in an ignored
directory and preserves an existing `config.js`. After installing the VSIX, set
`dryas.lspPath` and `dryas.apiPath` in the editor's **User Settings**, or put the
executables on PATH. Do not commit machine paths in workspace settings.

## Work with a project

Open a trusted project folder and write `.sysml` or `.kerml` files in the project folder.
Use `dryas.modelRoots` for other source folders. The extension provides completion,
hover, cross-file definition navigation and live diagnostics.

Press F12 on standard-library names such as `ISQ::voltage` or `ScalarValues::Integer`
to open the engine's bundled, read-only source. Hover and further definition
navigation work there without a separate library download or project copy.
Use ordinary hover to read documentation; Ctrl-hover remains the editor's short
source preview and may not display the entire `doc`.

SysML/KerML disable the editor's word-based suggestions by default so ordinary
words from open library documents do not appear as completion candidates. Native
LSP completion remains enabled; explicit language-specific user settings take precedence.

Select a candidate and click its details arrow, or press Ctrl+Space again while
the suggestion list is open. Names and short types stay in the list; full details
load on demand. For example, the reference `ISQ::voltage` and its actual declaration
`ISQElectromagnetism::voltage` are shown separately. Aliases and short names retain
their insertion spelling. Elements without a `doc` show only their declaration
and origin. Completion and ordinary hover share native documentation extraction;
they do not generate inferred content. Continued typing of the same identifier
can reuse the list. Other model edits or an engine restart require fresh completion.

- `DRYAS: Restart Language Server`: reload the engine and project configuration.
- `DRYAS: Show Language Service Status`: inspect connection state, startup reason,
  attempt count and failure type.
- `DRYAS: Validate Saved Project`: display diagnostics for the complete saved project.
- `DRYAS: Show MCP Configuration`: generate local configuration for an external
  agent; keep it outside version control.

LSP handles unsaved content. MCP validates the saved snapshot on disk. Diagnostic
pagination does not change project error totals. The engine API does not provide
proof of completeness, so a result with zero errors is still `incomplete`.

**DRYAS: Connected** in the status bar means only that LSP connected. The maintained
engine does not announce index completion, so the extension reports `index: unconfirmed`.
A successful connection does not establish indexing or validation success, and
cross-file navigation may still be initializing.

Engine settings changes are applied after 750 milliseconds without further edits.
Only projects whose effective settings changed restart. Changing only the API path
updates saved-project validation while keeping LSP connected. Manual restarts take
effect immediately. The **DRYAS** output channel distinguishes invalid path syntax,
missing executables, access failures, version mismatches and timeouts, and records
startup reasons and failure stages. These status messages omit configured paths
and raw process exceptions. Enter executable paths without surrounding quotes in
the Settings UI; JSON settings files require normal JSON quoting and escaping.

## Development checks

| Command                         | Purpose                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `npm run check`                 | Local-information checks, formatting, lint, types, build and adapter unit tests |
| `npm run test:engine`           | Real language engine multi-file validation and an MCP stdio client test         |
| `npm run test:host`             | Isolated VS Code extension-host tests                                           |
| `npm run test:host -- --cursor` | The same host tests using the Cursor executable in `config.js`                  |
| `npm run watch`                 | Rebuild development code as it changes                                          |
| `npm run package:vsix`          | Build and package the development VSIX                                          |

Add `--vsix` to host tests to install the packaged extension into an isolated profile
and test its bundled code, for example `npm run test:host -- --cursor --vsix`.

Test logs, editor configuration and build outputs remain in ignored local directories.
GitHub Actions runs these checks on Windows and Linux for pull requests and pushes to `main`, including native engine/MCP tests and packaged VS Code extension tests. Successful jobs publish VSIX artifacts for 14 days. Cursor host tests remain a local check.

## Repository layout

- `packages/extension`: editor integration and the LSP client.
- `packages/engine-adapter`: engine processes, saved snapshots and validation results.
- `packages/mcp-server`: read-only tools for external agents.
- [Architecture](docs/architecture.md): current components and boundaries.

English is the default documentation language. Each user guide has English and Simplified Chinese editions linked at the top. Legal texts and generated third-party
notices retain their original wording.

## License

First-party DRYAS code uses the [Apache License 2.0](LICENSE).
`SPDX-License-Identifier: Apache-2.0` identifies a source file's license. The build
generates [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) from the JavaScript
dependencies actually bundled and includes licenses and notices in the VSIX.
Licensing and release inventories for the external language engine and its standard
library are managed separately.

## Projects

The **Projects** view in the dedicated **Systrace** sidebar lists the workspace's local project folders.
Use **New Systrace Project** to choose a name and parent directory, or **Open Systrace Project**
to add an existing folder. Each folder is a project root. Click a project to make it the
default target for saved validation and MCP configuration; switching editor tabs does not
change that selection. Other projects remain editable. Closing a project removes its
workspace entry and stops this extension's services, without deleting files or changing an
external agent's existing MCP connection. Save the VS Code workspace to reopen its project list.

Model files can live at the project root or in subfolders. `dryas.modelRoots` defaults to
`["."]`; an explicitly configured value such as `["model"]` is still respected. Change or
clear that setting if an older workspace should use the new default. Folder-scoped settings
can narrow the source directories. Hidden folders and `node_modules` are excluded, matching
the language service. Other folders, including `designs`, can contain model sources; generated
model files should live outside configured source roots. Custom glob exclusions are not
provided by this version.

Project roots must be separate, non-nested directories so two language services cannot own
the same source. An overlapping workspace configuration is reported instead of loading a
combined model. Projects do not automatically become one model or import one another.

Right-click a project and choose **Show MCP Configuration** to generate a connection bound
to that root and its configured model directories. A configuration already given to an agent
keeps that binding when the selected project changes. External agents manage their own chats;
this extension does not create or retarget those conversations. The existing four read-only
MCP tools are unchanged. Keep generated configurations containing local paths outside Git.

For an isolated two-project check, run `npm run test:host -- --projects --vsix`; add `--cursor`
to run the same check in the configured Cursor installation.

## Project tree

Click **Systrace** in the Activity Bar to open its dedicated sidebar, separate from
Explorer. Expand a project to browse configured **Sources** and the read-only
**Standard Library**. Source folders contain `.sysml` / `.kerml` files; expand a
file for the declaration hierarchy returned by the language engine. Click an
element to navigate to its source. Unsaved edits refresh the outline; file creation
and deletion refresh the folders. A refresh action is also available in the title bar.

Library discovery is lazy and lists library namespaces the engine exposes in the
current project context. Expand them for declared members and read-only source.
Name shadowing can affect the visible catalogue; imports and re-exports are not
expanded as duplicate declarations. Type labels use only engine-supplied information.
Browsing another project or a library does not rebind an existing agent conversation.
