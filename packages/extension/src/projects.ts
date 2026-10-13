// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

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

export function overlappingRoots(first: string, second: string): boolean {
  const nested = (a: string, b: string) => {
    const path = relative(a, b);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return nested(first, second) || nested(second, first);
}

/** Workspace folders are projects; selection is explicit and never follows editor focus. */
export class Projects
  implements vscode.TreeDataProvider<vscode.WorkspaceFolder>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<vscode.WorkspaceFolder | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private selected: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly status: (folder: vscode.WorkspaceFolder) => ProjectStatus | undefined,
    private readonly selectionChanged: () => void,
  ) {
    this.selected = context.workspaceState.get<string>("dryas.currentProject");
    this.disposables.push(
      vscode.window.createTreeView("systrace.projects", { treeDataProvider: this }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.commands.registerCommand("dryas.createProject", () => this.create()),
      vscode.commands.registerCommand("dryas.openProject", (uri?: vscode.Uri) => this.open(uri)),
      vscode.commands.registerCommand("dryas.selectProject", (folder?: vscode.WorkspaceFolder) =>
        this.select(folder),
      ),
      vscode.commands.registerCommand("dryas.closeProject", (folder?: vscode.WorkspaceFolder) =>
        this.close(folder),
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

  getChildren(): vscode.WorkspaceFolder[] {
    return [...this.folders];
  }

  getTreeItem(folder: vscode.WorkspaceFolder): vscode.TreeItem {
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.None);
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
