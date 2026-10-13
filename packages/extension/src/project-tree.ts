// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { publicError, resolveModelRoots } from "@dryas/engine-adapter";

export interface LibraryNamespace {
  name: string;
  uri: vscode.Uri;
  range: vscode.Range;
}
export interface ProjectBrowser {
  symbols(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>;
  libraries(folder: vscode.WorkspaceFolder): Promise<LibraryNamespace[]>;
  refreshLibraries(): void;
}
export interface ContentNode {
  nodeType: "source" | "directory" | "file" | "libraries" | "namespace" | "element" | "message";
  id: string;
  label: string;
  folder: vscode.WorkspaceFolder;
  parent: ProjectNode;
  uri?: vscode.Uri;
  range?: vscode.Range;
  detail?: string;
  kind?: vscode.SymbolKind;
  children?: ContentNode[];
}
export type ProjectNode = vscode.WorkspaceFolder | ContentNode;
export const isContentNode = (node: ProjectNode): node is ContentNode => "nodeType" in node;

/** File layout comes from the workspace; declarations and library locations come from the engine. */
export class ProjectTree implements vscode.Disposable {
  private readonly nodes = new Map<string, ContentNode>();
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<ContentNode>();
  private refreshAll = false;

  constructor(
    private readonly browser: ProjectBrowser,
    private readonly changed: (node?: ProjectNode) => void,
  ) {
    this.watchFolders();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watchFolders();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("dryas.modelRoots")) this.refresh();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length && ["sysml", "kerml"].includes(event.document.languageId))
          this.schedule(event.document.uri, false);
      }),
    );
  }

  private watchFolders(): void {
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, "**/*.{sysml,kerml}"),
        );
        watcher.onDidCreate((uri) => this.schedule(uri, true));
        watcher.onDidDelete((uri) => this.schedule(uri, true));
        watcher.onDidChange((uri) => this.schedule(uri, false));
        return watcher;
      });
  }

  private schedule(uri: vscode.Uri, structure: boolean): void {
    this.refreshAll ||= structure;
    for (const node of this.nodes.values())
      if (
        (node.nodeType === "file" || node.nodeType === "namespace") &&
        node.uri?.toString() === uri.toString()
      )
        this.pending.add(node);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.refreshAll) this.refresh();
      else this.pending.forEach((node) => this.changed(node));
      this.pending.clear();
      this.refreshAll = false;
    }, 250);
  }

  refresh(): void {
    this.nodes.clear();
    this.changed();
  }

  private remember(node: ContentNode): ContentNode {
    this.nodes.set(node.id, node);
    return node;
  }

  private message(parent: ProjectNode, label: string): ContentNode[] {
    const folder = isContentNode(parent) ? parent.folder : parent;
    return [
      {
        nodeType: "message",
        id: `${isContentNode(parent) ? parent.id : folder.uri.toString()}/message`,
        label,
        parent,
        folder,
      },
    ];
  }

  async children(parent: ProjectNode): Promise<ContentNode[]> {
    try {
      if (!isContentNode(parent)) {
        const settings = vscode.workspace.getConfiguration("dryas", parent.uri);
        const roots = await resolveModelRoots(
          parent.uri.fsPath,
          settings.get<string[]>("modelRoots", ["."]),
        );
        return [
          ...roots.map((root) =>
            this.remember({
              nodeType: "source",
              id: `${parent.uri}/source/${root}`,
              folder: parent,
              parent,
              label: `Sources · ${relative(parent.uri.fsPath, root).split(sep).join("/") || "."}`,
              uri: vscode.Uri.file(root),
            }),
          ),
          this.remember({
            nodeType: "libraries",
            id: `${parent.uri}/libraries`,
            label: "Standard Library",
            folder: parent,
            parent,
          }),
        ];
      }
      if (parent.nodeType === "element") return parent.children ?? [];
      if (parent.nodeType === "message") return [];
      if (parent.nodeType === "libraries") {
        const libraries = await this.browser.libraries(parent.folder);
        return libraries.length
          ? libraries.map((entry) =>
              this.remember({
                nodeType: "namespace",
                id: `${parent.id}/${entry.uri}/${entry.range.start.line}/${entry.name}`,
                label: entry.name,
                folder: parent.folder,
                parent,
                uri: entry.uri,
                range: entry.range,
              }),
            )
          : this.message(parent, "No library namespaces are exposed by the language engine.");
      }
      if (parent.nodeType === "file" || parent.nodeType === "namespace") {
        const symbols = await this.browser.symbols(parent.folder, parent.uri!);
        let declarations = symbols;
        if (parent.nodeType === "namespace") {
          const namespace = symbols.find(
            (symbol) =>
              "selectionRange" in symbol &&
              symbol.name === parent.label &&
              symbol.range.contains(parent.range!.start),
          );
          if (namespace && "children" in namespace) declarations = namespace.children;
        }
        return declarations.length
          ? this.elements(parent, declarations)
          : this.message(parent, "No declared members reported by the language engine.");
      }
      if ((await lstat(parent.uri!.fsPath)).isSymbolicLink())
        return this.message(parent, "Symbolic links and junctions are not model source folders.");
      const entries = (await readdir(parent.uri!.fsPath, { withFileTypes: true }))
        .filter(
          (entry) =>
            !entry.name.startsWith(".") &&
            entry.name !== "node_modules" &&
            !entry.isSymbolicLink() &&
            (entry.isDirectory() || /\.(sysml|kerml)$/i.test(entry.name)),
        )
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        );
      return entries.length
        ? entries.map((entry) =>
            this.remember({
              nodeType: entry.isDirectory() ? "directory" : "file",
              id: `${parent.id}/${entry.name}`,
              label: entry.name,
              uri: vscode.Uri.file(join(parent.uri!.fsPath, entry.name)),
              folder: parent.folder,
              parent,
            }),
          )
        : this.message(parent, "No model sources in this folder.");
    } catch (error) {
      return this.message(parent, publicError(error).message);
    }
  }

  private elements(
    parent: ContentNode,
    symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ): ContentNode[] {
    return symbols.map((symbol, index) => {
      const hierarchical = "selectionRange" in symbol;
      const node: ContentNode = {
        nodeType: "element",
        id: `${parent.id}/element/${index}/${symbol.name}`,
        label: symbol.name,
        folder: parent.folder,
        parent,
        kind: symbol.kind,
        uri: hierarchical ? parent.uri! : symbol.location.uri,
        range: hierarchical ? symbol.selectionRange : symbol.location.range,
        detail: hierarchical ? symbol.detail : symbol.containerName,
      };
      node.children = hierarchical ? this.elements(node, symbol.children) : [];
      return node;
    });
  }

  item(node: ContentNode): vscode.TreeItem {
    const leaf =
      node.nodeType === "message" || (node.nodeType === "element" && !node.children?.length);
    const item = new vscode.TreeItem(
      node.label,
      leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = node.id;
    item.contextValue = `systrace${node.nodeType}`;
    const icons: Record<ContentNode["nodeType"], string> = {
      source: "root-folder",
      directory: "folder",
      file: "file-code",
      libraries: "library",
      namespace: "package",
      element: "symbol-field",
      message: "info",
    };
    item.iconPath = new vscode.ThemeIcon(icons[node.nodeType]);
    if (node.nodeType === "libraries") {
      item.description = "Read-only";
      item.tooltip =
        "Library namespaces exposed in this project's language-engine context. Declarations only; imported members are not expanded.";
    } else if (node.nodeType === "element") {
      item.description =
        node.detail ||
        ([vscode.SymbolKind.Namespace, vscode.SymbolKind.Package].includes(node.kind!)
          ? "package"
          : "");
      if ([vscode.SymbolKind.Namespace, vscode.SymbolKind.Package].includes(node.kind!))
        item.iconPath = new vscode.ThemeIcon("package");
      item.tooltip = `${node.label}${node.detail ? `\n${node.detail}` : ""}\n${basename(node.uri!.path)}:${node.range!.start.line + 1}`;
    } else if (node.uri) {
      item.resourceUri = node.uri;
      item.tooltip =
        node.uri.scheme === "file"
          ? node.uri.fsPath
          : `${node.label} — bundled library (read-only)`;
    }
    if (["file", "namespace", "element"].includes(node.nodeType) && node.uri) {
      const selection = node.range
        ? new vscode.Range(node.range.start, node.range.start)
        : undefined;
      item.command = {
        command: "vscode.open",
        title: "Open Source",
        arguments: [node.uri, { preview: true, ...(selection ? { selection } : {}) }],
      };
    }
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.pending.clear();
    this.nodes.clear();
    this.watchers.forEach((watcher) => watcher.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}
