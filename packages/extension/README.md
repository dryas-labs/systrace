# DRYAS Systrace

**English** | [简体中文](README.zh-Hans.md)

SysML v2 editing for VS Code and Cursor, powered by an external language engine.
This is an early development extension. View rendering and a built-in agent are not implemented.

Version 0.1.10 uses language engine build `v0.9.2-dryas.5`. Selected completion details show
the native declaration signature, visible reference, actual declaration origin,
source filename and full documentation. Details load on selection and share the
engine's documentation extraction with hover. Aliases retain their insertion
spelling; undocumented elements show their declaration and source only.
Use the details arrow, or Ctrl+Space while the suggestion list is open, to expand
the editor's native detail panel. Update both external engine executables; if
you set `dryas.expectedEngineVersion` explicitly, change it to `v0.9.2-dryas.5`.

See [Language engine](../../docs/language-engine.md) for the current selection.

## Getting started

1. Build the configured language engine version described in the repository's `config/engine.json`.
2. Put `sysml-lsp` and `sysml-grpc` on PATH, or set **DRYAS: Lsp Path** and
   **DRYAS: Api Path** in your editor's **User Settings**. Keep machine paths out of committed workspace settings.
3. Open a trusted project folder with SysML/KerML files under the project root, or configure
   **DRYAS: Model Roots** with the project's source folders.
4. Open a `.sysml` file for diagnostics, completion, hover and definition navigation.

The engine and its standard library are not bundled in this VSIX. Model folders
must contain readable UTF-8 files; symbolic links/junctions are refused in this slice.
Hidden folders and `node_modules` are excluded. Configure narrower model roots when needed.

If startup reports `INVALID_PATH during model-folders`, check **DRYAS: Model Roots**
in Workspace Settings (Workspace Folder Settings for a multi-root workspace).
The default `["."]` scans the project root. Explicit source folders are relative to
that root. For example,
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
action asks which one to use. Names are quoted in the generated SysML, supporting
spaces and keywords. Existing files are never overwritten. The filename and package
name can subsequently be changed independently. Creating from another project's
context menu does not change the current project or existing MCP bindings.
