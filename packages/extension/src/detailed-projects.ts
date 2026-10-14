// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { projectIconName } from "./project-icons.js";
import { randomUUID } from "node:crypto";
import type { Projects } from "./projects.js";
import { isContentNode, type ProjectNode } from "./project-tree.js";
import { publicError } from "@dryas/engine-adapter";

const actions: Record<string, string> = {
  selectProject: "dryas.selectProject",
  closeProject: "dryas.closeProject",
  validateProject: "dryas.validateProject",
  configureModelRoots: "dryas.configureModelRoots",
  newNamespace: "dryas.newNamespaceInFolder",
  deleteNamespace: "dryas.deleteNamespace",
  addProjectReference: "dryas.addProjectReference",
  removeProjectReference: "dryas.removeProjectReference",
  openReferencedProject: "dryas.openReferencedProject",
};

/** Optional two-line presentation over the same project provider and commands. */
export class DetailedProjects implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private revision = 0;
  private ready = false;
  private readonly nodes = new Map<string, ProjectNode>();
  private readonly allowed = new Map<string, Set<string>>();
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: Projects,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider("systrace.projectsDetailed", this),
      projects.onDidChangeTreeData(() => this.refresh()),
      ...Object.entries(actions).map(([action, command]) =>
        vscode.commands.registerCommand(`dryas.detailed.${action}`, async (argument: unknown) => {
          if (
            !argument ||
            typeof argument !== "object" ||
            !("systraceNode" in argument) ||
            typeof argument.systraceNode !== "string"
          )
            return;
          const node = this.nodes.get(argument.systraceNode);
          if (node && this.allowed.get(argument.systraceNode)?.has(action))
            await vscode.commands.executeCommand(
              command,
              isContentNode(node) &&
                [
                  "selectProject",
                  "closeProject",
                  "validateProject",
                  "configureModelRoots",
                ].includes(action)
                ? node.folder
                : node,
            );
        }),
      ),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.viewDisposables.forEach((item) => item.dispose());
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomUUID().replaceAll("-", "");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "project-tree.css"));
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "project-tree.js"));
    const lightIcons = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "tree-icons", "light"));
    const darkIcons = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "tree-icons", "dark"));
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><div id="tree" data-icons-light="${lightIcons}" data-icons-dark="${darkIcons}" role="tree" aria-label="Systrace projects"></div><div id="empty" hidden><p>Create a project or open an existing folder.</p><button data-global="createProject">New Project</button><button data-global="openProject">Open Project</button></div><p id="status" role="status"></p><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.viewDisposables = [
      view.webview.onDidReceiveMessage((message) => {
        void this.receive(message);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.refresh();
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.nodes.clear();
          this.allowed.clear();
        }
      }),
    ];
    view.webview.html = html;
  }

  private refresh(): void {
    this.revision++;
    this.nodes.clear();
    this.allowed.clear();
    if (this.view?.visible)
      void this.view.webview.postMessage({ type: "reset", revision: this.revision });
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const request = message as Record<string, unknown>;
    if (request.type === "ready") {
      this.ready = true;
      this.refresh();
      return;
    }
    if (
      request.type === "global" &&
      ["createProject", "openProject"].includes(String(request.action))
    ) {
      await vscode.commands.executeCommand(`dryas.${request.action}`);
      return;
    }
    if (request.revision !== this.revision) return;
    const node = typeof request.node === "string" ? this.nodes.get(request.node) : undefined;
    if (request.node !== null && !node) return;
    const revision = this.revision;
    try {
      if (request.type === "open" && node) {
        const item = this.projects.getTreeItem(node);
        if (item.command)
          await vscode.commands.executeCommand(
            item.command.command,
            ...(item.command.arguments ?? []),
          );
      } else if (request.type === "children") {
        const children = (await this.projects.getChildren(node)) ?? [];
        if (this.revision !== revision) return;
        const items = children.map((child) => {
          const item = this.projects.getTreeItem(child);
          const id = item.id ?? (isContentNode(child) ? child.id : child.uri.toString());
          this.nodes.set(id, child);
          const eligible: Record<string, string[]> = {
            systraceProject: [
              "selectProject",
              "closeProject",
              "validateProject",
              "configureModelRoots",
              "newNamespace",
              "addProjectReference",
            ],
            systracesource: ["newNamespace"],
            systracedirectory: ["newNamespace"],
            systraceNamespaceFile: ["deleteNamespace"],
            systracereferences: ["addProjectReference"],
            systraceProjectReference: ["removeProjectReference", "openReferencedProject"],
            systraceTransitiveReference: ["openReferencedProject"],
          };
          this.allowed.set(id, new Set(eligible[item.contextValue ?? ""] ?? []));
          const presentation = isContentNode(child) ? child.presentation : undefined;
          return {
            id,
            label: isContentNode(child) ? child.label : child.name,
            detail: presentation
              ? [presentation.kind, presentation.declaredType].filter(Boolean).join(" · ")
              : typeof item.description === "string"
                ? item.description
                : "",
            kind: isContentNode(child) ? child.nodeType : "project",
            icon: projectIconName(
              isContentNode(child) ? child.nodeType : "project",
              presentation,
              isContentNode(child) ? child.kind : undefined,
            ),
            tooltip: typeof item.tooltip === "string" ? item.tooltip : "",
            context: item.contextValue,
            expandable: item.collapsibleState !== vscode.TreeItemCollapsibleState.None,
            ...(presentation
              ? {
                  family: presentation.family,
                  reference: presentation.reference,
                  definition: presentation.definition,
                }
              : {}),
          };
        });
        await this.view?.webview.postMessage({
          type: "children",
          revision,
          parent: request.node,
          items,
        });
      }
    } catch (error) {
      if (this.revision === revision)
        await this.view?.webview.postMessage({
          type: "error",
          revision,
          parent: request.node,
          message: publicError(error).message,
        });
    }
  }

  getState(): { visible: boolean; ready: boolean; items: number } {
    return { visible: this.view?.visible ?? false, ready: this.ready, items: this.nodes.size };
  }

  dispose(): void {
    this.viewDisposables.forEach((item) => item.dispose());
    this.disposables.forEach((item) => item.dispose());
    this.nodes.clear();
    this.view = undefined;
  }
}
