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

Version 0.1.20 uses `v0.9.2-dryas.6`. Selected completion details show the native
declaration, reference spelling, actual declaration origin, source filename and
complete `doc`. Update the VSIX and both external executables together. If you
set `dryas.expectedEngineVersion` explicitly, update it to `v0.9.2-dryas.6` too.
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
Use **Configure Model Source Folders** for other source folders. The extension provides completion,
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
manually configured external agent's existing MCP connection. Save the VS Code workspace to reopen its project list.

Model files can live at the project root or in subfolders. Use **Configure Model Source
Folders** to save the scope in `.systrace/project.json`. Existing projects without this file
use `dryas.modelRoots`, defaulting to `["."]`; older explicit values such as `["model"]`
remain effective until the shared project configuration is created. Hidden folders and `node_modules` are excluded, matching
the language service. Other folders, including `designs`, can contain model sources; generated
model files should live outside configured source roots. Custom glob exclusions are not
provided by this version.

Project roots must be separate, non-nested directories so two language services cannot own
the same source. An overlapping workspace configuration is reported instead of loading a
combined model. Opening projects does not create a dependency; use Add Project Reference to declare one.

Right-click a project and choose **Show MCP Configuration** to generate a connection bound
to that root and its configured model directories. A configuration already given to an agent
keeps that binding when the selected project changes. External agents manage their own chats;
this extension does not create or retarget those conversations. The existing four read-only
MCP tools are unchanged. Keep generated configurations containing local paths outside Git.

For an isolated two-project check, run `npm run test:host -- --projects --vsix`; add `--cursor`
to run the same check in the configured Cursor installation. Project-reference checks use
`npm run test:host -- --references --vsix`.

## Project tree

Click **Systrace** in the Activity Bar to open its dedicated sidebar, separate from
Explorer. With the default source scope, model files and subfolders appear directly
under the project name. Separately configured source folders use their actual
project-relative names. The read-only **Standard Library** is a separate node.
Source folders contain `.sysml` / `.kerml` files; expand a
file for the declaration hierarchy returned by the language engine. Click an
element to navigate to its source. Unsaved edits refresh the outline; file creation
and deletion refresh the folders. A refresh action is also available in the title bar.

Library discovery is lazy and lists library namespaces the engine exposes in the
current project context. Expand them for declared members and read-only source.
Name shadowing can affect the visible catalogue; imports and re-exports are not
expanded as duplicate declarations. Type labels use only engine-supplied information.
Browsing another project or a library does not rebind an existing agent conversation.

Right-click a project or source folder and choose **New Namespace…**, or use the
same action in the Projects title bar. Enter a name to create and open a matching
`.sysml` file containing a named `package`. With multiple source folders, a project-level
action asks which one to use. The project's LSP checks an unquoted declaration first,
then a quoted declaration if necessary. Creation requires diagnostics without errors
and the exact expected package name in the returned outline. No local keyword list or
identifier regular expression decides the spelling. Temporary buffers are closed after
checking; unavailable, failed or timed-out checks do not create a file.
Existing files are never overwritten. The filename and package
name can subsequently be changed independently. Creating from another project's
context menu does not change the current project or existing MCP bindings.

Names containing an apostrophe currently cannot pass this creation check when the
language service returns an escaped label instead of the requested name. The action
reports that it could not confirm the name and leaves the project files unchanged.

To remove a namespace file, right-click its `.sysml` file node and choose
**Delete Namespace…**. A modal confirmation shows the project and relative file
path. Only **Delete** proceeds; cancelling or closing the dialog keeps the file.
The entire file and all declarations in it are removed through the editor's file
operation. The tree refreshes after deletion. This action is unavailable on model
elements, folders, KerML files and read-only library nodes.

## Project references

Right-click the consuming project and choose **Add Project Reference…**. Select an open
project or **Browse for Project Folder…** to choose an external project folder. With no
other project open, the folder dialog appears directly. External references do not add
workspace folders or change the current project. Projects already directly referenced are
hidden from the picker; selecting the same folder through Browse reports an existing reference. **Project References**
shows direct and transitive references. Referenced files open read-only in the consumer's
language context; **Open Referenced Project** opens the owning project for editing.
**Remove Project Reference** removes the relationship, not the referenced files. A dependency
remains available when its project is closed in the workspace.

Project source folders and references are stored in `.systrace/project.json` with relative
paths. New projects create this file. Adding a reference initializes missing configuration
for open projects using their current source folders. External folders are left unchanged:
their existing project configuration supplies the scope, or the entire folder is used
when no configuration exists. **Configure Model Source Folders**
also writes this file. It takes precedence over the legacy `dryas.modelRoots` setting and
MCP's `--model-root` fallback. Engine executable paths stay in local editor configuration.

```json
{
  "version": 1,
  "modelRoots": ["."],
  "references": ["../SharedComponents"]
}
```

The LSP, saved validation and MCP queries load the same dependency closure. Only saved
changes in referenced projects propagate to consumers; unsaved work stays in the owning
project's editing session. Saved dependency changes refresh consumer analysis and read-only
tabs. Reference/source-configuration changes reconnect affected language services and close
their old dependency tabs. Deleting a dependency source also reloads its consumers to
remove cached declarations. Ordinary saved edits use file updates without restarting.
Existing MCP connections keep their project root while reading
updated project configuration on each request.

A project reference makes source available; SysML `import` still controls namespace access.
The engine resolves names and reports model conflicts. Project-reference cycles, missing
folders and overlapping project roots are reported as project configuration errors; this
version rejects reference cycles as a loading policy, not a SysML language rule. Projects
must be on the same drive for relative references. Saved validation reports dependency files
under `.references/<id>/…`, with `content.references` mapping these IDs to projects.

## Project tree display

**DRYAS › Project Tree: Display Mode** is a User setting shared by all projects.
The default **Compact — one line** uses the editor's native tree: element name,
explicit type and declaration kind. **Detailed — two lines** uses a custom sidebar
presentation, with the name above its kind and type. Both use the same project
provider and commands. Switching modes does not reconnect the language engine or
change project/MCP scope. Expansion state is kept separately by each view.

Declaration kinds, reference modifiers and explicit types come from the language
engine's document outline. Systrace does not parse model text to invent missing
labels. This development version requires engine build `v0.9.2-dryas.6` for the
outline details. Symbols without presentation information retain a generic icon.

Both display modes share the same icons and category mapping. Definitions add a straight
vertical bar of fixed length and spacing to the left of the category's base shape; usages
use the same base shape without the bar. Amber and blue reinforce the distinction.
Packages, comments, documentation and aliases have separate neutral icons.
Metadata uses an `@` motif; multiplicity uses brackets, not `#`. A `ref part` keeps its part
icon and native `ref part` label. KerML types and features use the corresponding visual
families while retaining their native kind names. These are Systrace UI conventions.

The display reflects only the distinctions supplied by the engine. Unknown categories use a
question-mark icon with the original label. For example, an `enum` label alone cannot tell
an enumeration literal from a usage.

## Workspace MCP integration

In VS Code hosts that support MCP server definition providers, the extension automatically
registers one server for each local project in a trusted workspace. Labels include the project
name and a workspace-persisted number to distinguish duplicate names. Opening or closing projects
and changing engine settings updates registration. Each server stays bound to its project;
selecting another project does not retarget an agent connection. Project references are read
from the shared project configuration.

Choose **Manage Workspace MCP Servers** from the Systrace project or sidebar menu, or run
**DRYAS: Manage Workspace MCP Servers**. This opens the host's MCP server list with actual
connection status, start, stop, restart, enable, disable and output controls. The host owns
enablement and startup policy; registration alone does not mean connected. The project tree's
`connected` status still refers to LSP. Host trust and tool authorization settings apply.

Automatic registration uses the editor's bundled Node.js and does not create or overwrite
workspace or global MCP configuration files. If the same project was previously registered
manually, disable that old entry in the host to avoid duplicate tools.
**Show MCP Configuration** remains available for other agent clients; its exported configuration
uses the system `node` command. Editors without the provider API retain manual configuration,
including Cursor versions that do not implement this VS Code interface.
