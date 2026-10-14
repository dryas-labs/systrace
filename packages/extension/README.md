# DRYAS Systrace

**English** | [简体中文](README.zh-Hans.md)

SysML v2 editing for VS Code and Cursor, powered by an external language engine.
This is an early development extension. View rendering and a built-in agent are not implemented.

Version 0.1.20 uses language engine build `v0.9.2-dryas.6`. Selected completion details show
the native declaration signature, visible reference, actual declaration origin,
source filename and full documentation. Details load on selection and share the
engine's documentation extraction with hover. Aliases retain their insertion
spelling; undocumented elements show their declaration and source only.
Use the details arrow, or Ctrl+Space while the suggestion list is open, to expand
the editor's native detail panel. Update both external engine executables; if
you set `dryas.expectedEngineVersion` explicitly, change it to `v0.9.2-dryas.6`.

See [Language engine](../../docs/language-engine.md) for the current selection.

## Getting started

1. Build the configured language engine version described in the repository's `config/engine.json`.
2. Put `sysml-lsp` and `sysml-grpc` on PATH, or set **DRYAS: Lsp Path** and
   **DRYAS: Api Path** in your editor's **User Settings**. Keep machine paths out of committed workspace settings.
3. Open a trusted project folder with SysML/KerML files under the project root, or configure
   the project's source folders with **Configure Model Source Folders**.
4. Open a `.sysml` file for diagnostics, completion, hover and definition navigation.

The engine and its standard library are not bundled in this VSIX. Model folders
must contain readable UTF-8 files; symbolic links/junctions are refused in this slice.
Hidden folders and `node_modules` are excluded. Configure narrower model roots when needed.

If startup reports an invalid model folder, use **Configure Model Source Folders** or
check `modelRoots` in `.systrace/project.json`. The default `["."]` scans the project root.
Explicit folders are relative to that root. Without a shared project configuration,
`dryas.modelRoots` in Workspace Folder Settings is the fallback. Correcting the
configuration retries the connection; after creating a previously missing directory,
use **DRYAS: Restart Language Server**.

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
