// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AdapterError, containsPath, relativeName, type ProjectGraph } from "@dryas/engine-adapter";

/** Dependency tabs show saved source in the consuming project's language context. */
export class ReferenceDocuments implements vscode.TextDocumentContentProvider {
  readonly scheme = `systrace-reference-${randomUUID()}`;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly registration: vscode.Disposable;

  constructor(private readonly graph: ProjectGraph) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(this.scheme, this);
  }

  fromSource(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme !== "file") return uri;
    const project = this.graph.projects
      .slice(1)
      .find((entry) => entry.roots.some((root) => containsPath(root, uri.fsPath)));
    if (!project) return uri;
    return vscode.Uri.from({
      scheme: this.scheme,
      path: "/" + relative(project.root, uri.fsPath).split(sep).join("/"),
      query: new URLSearchParams({ project: project.path }).toString(),
    });
  }

  toSource(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme !== this.scheme) return uri;
    const project = this.graph.projects
      .slice(1)
      .find((entry) => entry.path === new URLSearchParams(uri.query).get("project"));
    if (!project)
      throw new AdapterError("INVALID_PATH", "This project reference is no longer available.");
    const name = relativeName(uri.path.slice(1));
    const path = join(project.root, name);
    if (!project.roots.some((root) => containsPath(root, path)))
      throw new AdapterError(
        "INVALID_PATH",
        "This source is outside the referenced project's model folders.",
      );
    return vscode.Uri.file(path);
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const source = this.toSource(uri);
    const info = await lstat(source.fsPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      relative(source.fsPath, await realpath(source.fsPath)) !== "" ||
      info.size > 2 * 1024 * 1024
    )
      throw new AdapterError(
        "INVALID_PATH",
        "The referenced model source cannot be read as a regular model file.",
      );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(source.fsPath));
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return content;
  }

  refresh(source: vscode.Uri): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== this.scheme) continue;
      if (relative(this.toSource(document.uri).fsPath, source.fsPath) === "")
        this.changed.fire(document.uri);
    }
  }

  async close(): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === this.scheme,
      );
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    this.registration.dispose();
    this.changed.dispose();
  }
}
