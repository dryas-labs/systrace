// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import {
  ProjectTree,
  isContentNode,
  type ProjectBrowser,
  type ProjectNode,
} from "./project-tree.js";
import { resolveModelRoots, publicError, AdapterError } from "@dryas/engine-adapter";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

export interface ProjectStatus {
  connection: string;
  message: string;
}

export function validProjectName(value: string): string | undefined {
  if (!value.trim()) return "Enter a project name.";
  if (
    value !== value.trim() ||
    /[\\/:*?"<>|]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    return "Use a folder name without path separators or reserved characters.";
  return undefined;
}

function validNamespaceFileName(name: string): string | undefined {
  return (
    validProjectName(name) ??
    (name.startsWith(".") ? "Use a namespace name that does not start with a dot." : undefined)
  );
}

export function overlappingRoots(first: string, second: string): boolean {
  const nested = (a: string, b: string) => {
    const path = relative(a, b);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return nested(first, second) || nested(second, first);
}

/** Workspace folders are projects; selection is explicit and never follows editor focus. */
export class Projects implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ProjectNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private selected: string | undefined;
  private readonly contents: ProjectTree | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly status: (folder: vscode.WorkspaceFolder) => ProjectStatus | undefined,
    private readonly selectionChanged: () => void,
    browser?: ProjectBrowser,
    private readonly namespacePreparation?: (
      folder: vscode.WorkspaceFolder,
      name: string,
    ) => Promise<string>,
  ) {
    this.selected = context.workspaceState.get<string>("dryas.currentProject");
    if (browser) {
      this.contents = new ProjectTree(browser, (node) => this.changed.fire(node));
      this.disposables.push(this.contents);
    }
    this.disposables.push(
      vscode.commands.registerCommand("dryas.refreshProjects", () => {
        browser?.refreshLibraries();
        this.contents?.refresh();
        this.refresh();
      }),
    );
    this.disposables.push(
      vscode.window.createTreeView("systrace.projects", { treeDataProvider: this }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.commands.registerCommand("dryas.createProject", () => this.create()),
      // Title actions receive the focused tree element from the editor. A tree
      // element is not an explicit resource argument or a creation destination.
      vscode.commands.registerCommand("dryas.newNamespace", () => this.newNamespace()),
      vscode.commands.registerCommand("dryas.newNamespaceInFolder", (node: ProjectNode) =>
        this.newNamespace(node),
      ),
      vscode.commands.registerCommand("dryas.openProject", (argument?: unknown) => {
        const uri =
          argument && typeof argument === "object" && "scheme" in argument && "fsPath" in argument
            ? (argument as vscode.Uri)
            : undefined;
        return this.open(uri);
      }),
      vscode.commands.registerCommand("dryas.selectProject", (folder?: vscode.WorkspaceFolder) =>
        this.select(folder),
      ),
      vscode.commands.registerCommand("dryas.closeProject", (folder?: vscode.WorkspaceFolder) =>
        this.close(folder),
      ),
      vscode.commands.registerCommand("dryas.deleteNamespace", (node?: ProjectNode) =>
        this.deleteNamespace(node),
      ),
    );
  }

  get folders(): readonly vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "file",
    );
  }

  get current(): vscode.WorkspaceFolder | undefined {
    return (
      this.folders.find((folder) => folder.uri.toString() === this.selected) ?? this.folders[0]
    );
  }

  getChildren(node?: ProjectNode): vscode.ProviderResult<ProjectNode[]> {
    return node ? (this.contents?.children(node) ?? []) : [...this.folders];
  }

  getParent(node: ProjectNode): ProjectNode | undefined {
    return isContentNode(node) ? node.parent : undefined;
  }

  getTreeItem(node: ProjectNode): vscode.TreeItem {
    if (isContentNode(node)) return this.contents!.item(node);
    const folder = node;
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = folder.uri.toString();
    item.contextValue = "systraceProject";
    item.iconPath = new vscode.ThemeIcon("project");
    const current = this.current?.uri.toString() === folder.uri.toString();
    const status = this.status(folder);
    item.description = [current ? "Current" : "", status?.connection ?? "Opening"]
      .filter(Boolean)
      .join(" · ");
    item.tooltip = `${folder.name}\n${folder.uri.fsPath}\n${status?.message ?? "Project root; model files can be placed anywhere inside it."}`;
    item.command = { command: "dryas.selectProject", title: "Use Project", arguments: [folder] };
    return item;
  }

  refresh(): void {
    this.changed.fire(undefined);
    this.selectionChanged();
  }

  /** Resolve a command argument once; async work retains this folder after selection changes. */
  resolve(folder?: vscode.WorkspaceFolder): vscode.WorkspaceFolder | undefined {
    if (!folder) return this.current;
    return this.folders.find((candidate) => candidate.uri.toString() === folder.uri.toString());
  }

  async select(folder?: vscode.WorkspaceFolder): Promise<void> {
    if (!folder) {
      const pick = await vscode.window.showQuickPick(
        this.folders.map((entry) => ({
          label: entry.name,
          description: entry.uri.fsPath,
          folder: entry,
        })),
        { placeHolder: "Select the current Systrace project" },
      );
      folder = pick?.folder;
    }
    const resolved = folder && this.resolve(folder);
    if (!resolved) return;
    this.selected = resolved.uri.toString();
    await this.context.workspaceState.update("dryas.currentProject", this.selected);
    this.refresh();
  }

  private async add(uri: vscode.Uri, name: string): Promise<void> {
    const root = await realpath(uri.fsPath);
    if (!(await stat(root)).isDirectory()) throw new Error("not-directory");
    for (const folder of this.folders) {
      const existing = await realpath(folder.uri.fsPath);
      if (relative(existing, root) === "") {
        await this.select(folder);
        return;
      }
      if (overlappingRoots(existing, root)) {
        void vscode.window.showErrorMessage(
          "Project roots must not overlap. Open the nested project in a separate workspace, or choose separate project folders.",
        );
        return;
      }
    }
    const projectUri = vscode.Uri.file(root);
    this.selected = projectUri.toString();
    await this.context.workspaceState.update("dryas.currentProject", this.selected);
    // Adding the first folder can restart the extension host; selection is saved first.
    if (
      !vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
        uri: projectUri,
        name,
      })
    ) {
      void vscode.window.showErrorMessage("The project could not be added to this workspace.");
    }
    this.refresh();
  }

  async create(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "New Systrace Project",
      prompt: "Project name",
      validateInput: validProjectName,
    });
    if (!name || validProjectName(name)) return;
    const selected = await vscode.window.showOpenDialog({
      title: "Choose the parent folder for the new project",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Create Here",
    });
    const parent = selected?.[0];
    if (!parent || parent.scheme !== "file") return;
    try {
      const root = join(parent.fsPath, name);
      for (const folder of this.folders) {
        if (overlappingRoots(await realpath(folder.uri.fsPath), root)) {
          void vscode.window.showErrorMessage(
            "Choose a project location outside the existing project roots.",
          );
          return;
        }
      }
      await mkdir(root);
      await this.add(vscode.Uri.file(root), name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      void vscode.window.showErrorMessage(
        code === "EEXIST"
          ? "This folder already exists. Use Open Systrace Project to add it."
          : "The project could not be created. Check the selected folder and its permissions.",
      );
    }
  }

  async open(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
      uri = (
        await vscode.window.showOpenDialog({
          title: "Open Systrace Project",
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Open Project",
        })
      )?.[0];
    }
    if (!uri || uri.scheme !== "file") return;
    try {
      await this.add(uri, basename(uri.fsPath));
    } catch {
      void vscode.window.showErrorMessage(
        "The project folder could not be opened. Check that it exists and is accessible.",
      );
    }
  }

  async prepareNamespace(folder: vscode.WorkspaceFolder, name: string): Promise<string> {
    if (!this.resolve(folder) || !this.namespacePreparation)
      throw new AdapterError(
        "ENGINE_UNAVAILABLE",
        "Connect the project's language service before creating a namespace.",
      );
    return this.namespacePreparation(folder, name);
  }

  async newNamespace(requested?: ProjectNode): Promise<void> {
    const node = requested && isContentNode(requested) ? requested : undefined;
    if (node && !["source", "directory"].includes(node.nodeType)) return;
    const folder = this.resolve(
      node ? node.folder : (requested as vscode.WorkspaceFolder | undefined),
    );
    if (!folder) {
      void vscode.window.showInformationMessage("Open a Systrace project first.");
      return;
    }
    try {
      const roots = await resolveModelRoots(
        folder.uri.fsPath,
        vscode.workspace.getConfiguration("dryas", folder.uri).get<string[]>("modelRoots", ["."]),
      );
      let directory: string | undefined;
      if (node) {
        if (node.uri?.scheme !== "file") return;
        const [target] = await resolveModelRoots(folder.uri.fsPath, [
          relative(folder.uri.fsPath, node.uri.fsPath) || ".",
        ]);
        if (
          !target ||
          !roots.some((source) => {
            const path = relative(source, target);
            return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
          })
        ) {
          void vscode.window.showErrorMessage(
            "Choose a folder inside the project's configured model sources.",
          );
          return;
        }
        directory = target;
      } else if (roots.length === 1) directory = roots[0];
      else
        directory = (
          await vscode.window.showQuickPick(
            roots.map((source) => ({
              label: relative(folder.uri.fsPath, source).split(sep).join("/") || folder.name,
              directory: source,
            })),
            { placeHolder: "Choose the source folder for the new namespace" },
          )
        )?.directory;
      if (!directory) return;
      const name = await vscode.window.showInputBox({
        title: "New Namespace",
        prompt: "Namespace name; a matching .sysml file will be created",
        validateInput: validNamespaceFileName,
      });
      if (!name || validNamespaceFileName(name) || !this.resolve(folder)) return;
      const source = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Checking namespace name" },
        () => this.prepareNamespace(folder, name),
      );
      if (!this.resolve(folder)) return;
      const uri = vscode.Uri.file(join(directory, `${name}.sysml`));
      await writeFile(uri.fsPath, source, { encoding: "utf8", flag: "wx" });
      this.contents?.refresh();
      this.refresh();
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
        preview: false,
        selection: new vscode.Range(1, 0, 1, 0),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "A file with this name already exists. Choose a different namespace name."
          : publicError(error).message,
      );
    }
  }

  async deleteNamespace(requested?: ProjectNode): Promise<void> {
    if (
      !requested ||
      !isContentNode(requested) ||
      requested.nodeType !== "file" ||
      requested.uri?.scheme !== "file" ||
      extname(requested.uri.fsPath).toLowerCase() !== ".sysml"
    )
      return;
    const folder = this.resolve(requested.folder);
    if (!folder) return;
    const uri = requested.uri;
    const verifyTarget = async () => {
      if (!this.resolve(folder))
        throw new AdapterError(
          "PROJECT_CHANGED",
          "The project was closed before deletion. No file was deleted.",
        );
      const roots = await resolveModelRoots(
        folder.uri.fsPath,
        vscode.workspace.getConfiguration("dryas", folder.uri).get<string[]>("modelRoots", ["."]),
      );
      const [directory] = await resolveModelRoots(folder.uri.fsPath, [
        relative(folder.uri.fsPath, dirname(uri.fsPath)) || ".",
      ]);
      const file = await lstat(uri.fsPath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        !directory ||
        !roots.some((source) => {
          const path = relative(source, directory);
          return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
        })
      )
        throw new AdapterError(
          "INVALID_PATH",
          "Choose a .sysml file inside this project's model sources.",
        );
    };
    try {
      await verifyTarget();
      const cancel = { title: "Cancel", isCloseAffordance: true };
      const remove = { title: "Delete" };
      const dirty = vscode.workspace.textDocuments.some(
        (document) => document.uri.toString() === uri.toString() && document.isDirty,
      );
      const choice = await vscode.window.showWarningMessage(
        `Delete namespace file "${basename(uri.fsPath)}"?`,
        {
          modal: true,
          detail: `Project: ${folder.name}\nFile: ${relative(folder.uri.fsPath, uri.fsPath).split(sep).join("/")}\n\nThe entire .sysml file will be deleted, including all declarations it contains.${dirty ? "\nThis file has unsaved changes." : ""}`,
        },
        cancel,
        remove,
      );
      if (choice !== remove) return;
      await verifyTarget();
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
      if (!(await vscode.workspace.applyEdit(edit))) return;
      this.contents?.refresh();
      this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof AdapterError
          ? error.message
          : "The namespace file could not be deleted. Check that it still exists and is writable.",
      );
    }
  }

  async close(folder?: vscode.WorkspaceFolder): Promise<void> {
    const resolved = this.resolve(folder);
    if (!resolved) return;
    if (resolved.uri.toString() === this.current?.uri.toString()) {
      this.selected = this.folders
        .find((entry) => entry.uri.toString() !== resolved.uri.toString())
        ?.uri.toString();
      await this.context.workspaceState.update("dryas.currentProject", this.selected);
    }
    // Remove only the workspace entry. Files and external MCP processes are untouched.
    if (!vscode.workspace.updateWorkspaceFolders(resolved.index, 1))
      void vscode.window.showErrorMessage("The project could not be closed in this workspace.");
    this.refresh();
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.changed.dispose();
  }
}
