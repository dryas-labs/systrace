// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import type { Projects } from "../../packages/extension/src/projects.js";
import type { ContentNode } from "../../packages/extension/src/project-tree.js";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function eventually<T>(
  read: () => PromiseLike<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 30000;
  do {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < until);
  throw new Error("Project integration did not reach the expected state.");
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("dryas-labs.systrace");
  assert(extension);
  await extension.activate();
  const [a, b] = vscode.workspace.workspaceFolders ?? [];
  assert(a && b);
  const state = extension.exports as {
    getLanguageServiceStatus(): { connection: string }[];
    getProjectTree(): Projects;
  };
  await eventually(
    async () => state.getLanguageServiceStatus(),
    (statuses) => statuses.length === 2 && statuses.every((s) => s.connection === "connected"),
  );
  for (const [folder, relative, type, definition] of [
    [a, "design/system.sysml", "Battery", "definitions.sysml"],
    [b, "system.sysml", "Motor", "library/definitions.sysml"],
  ] as const) {
    const uri = vscode.Uri.joinPath(folder.uri, relative);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    const offset = document.getText().indexOf(`: ${type}`) + 2;
    assert(offset > 1);
    await eventually(
      () =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          "vscode.executeDefinitionProvider",
          uri,
          document.positionAt(offset + 1),
        ),
      (locations) =>
        !!locations?.some(
          (location) =>
            ("uri" in location ? location.uri : location.targetUri).toString() ===
            vscode.Uri.joinPath(folder.uri, definition).toString(),
        ),
    );
    await eventually(
      () =>
        vscode.commands.executeCommand<vscode.CompletionList>(
          "vscode.executeCompletionItemProvider",
          uri,
          document.positionAt(offset + 2),
        ),
      (completion) =>
        !!completion?.items.some(
          (item) => (typeof item.label === "string" ? item.label : item.label.label) === type,
        ),
    );
  }
  // Exercise the installed tree provider, not a separate test-only reconstruction.
  const tree = state.getProjectTree();
  const manifest = extension.packageJSON;
  assert.equal(manifest.contributes.views.systrace[0].id, "systrace.projects");
  assert(!manifest.contributes.views.explorer);
  await vscode.workspace.fs.stat(
    vscode.Uri.joinPath(
      extension.extensionUri,
      manifest.contributes.viewsContainers.activitybar[0].icon,
    ),
  );
  await vscode.commands.executeCommand("workbench.view.extension.systrace");
  await vscode.commands.executeCommand("dryas.selectProject", a);
  const children = async (
    node: import("../../packages/extension/src/project-tree.js").ProjectNode,
  ) => (await tree.getChildren(node)) as ContentNode[];
  const groups = await children(a);
  const sources = groups.find((node) => node.nodeType === "source");
  const library = groups.find((node) => node.nodeType === "libraries");
  assert(sources && library);
  assert.equal(sources.label, "Sources · .");
  const files = await children(sources);
  assert(!files.some((node) => node.label === "notes.md"));
  const definitions = files.find((node) => node.label === "definitions.sysml");
  const design = files.find((node) => node.label === "design");
  assert(definitions && design);
  assert((await children(design)).some((node) => node.label === "system.sysml"));
  const packageNode = (await children(definitions)).find((node) => node.label === "Components");
  assert(packageNode);
  const battery = (await children(packageNode)).find((node) => node.label === "Battery");
  assert(battery);
  const output = (await children(battery)).find((node) => node.label === "output");
  assert(output);
  assert.equal(tree.getParent(output), battery);
  const open = tree.getTreeItem(output).command!;
  await vscode.commands.executeCommand(open.command, ...open.arguments!);
  const editor = vscode.window.activeTextEditor!;
  assert.equal(editor.document.uri.toString(), definitions.uri!.toString());
  assert.equal(editor.selection.start.line, 3);
  let refreshed = false;
  const listener = tree.onDidChangeTreeData((node) => {
    if (!node || node === definitions) refreshed = true;
  });
  const change = new vscode.WorkspaceEdit();
  change.replace(editor.document.uri, new vscode.Range(3, 9, 3, 15), "backup");
  assert(await vscode.workspace.applyEdit(change));
  assert(editor.document.isDirty);
  await eventually(
    async () => refreshed,
    (ready) => ready,
  );
  const changedPackage = (await children(definitions)).find((node) => node.label === "Components")!;
  const changedBattery = (await children(changedPackage)).find((node) => node.label === "Battery")!;
  assert(
    (await children(changedBattery)).some((node) => node.label === "backup"),
    "The outline must use unsaved content",
  );
  listener.dispose();
  await editor.document.save();

  const namespaces = await children(library);
  const si = namespaces.find((node) => node.label === "SI");
  assert(si, "The library catalogue must come from the native engine");
  assert((await children(si)).some((node) => node.label === "volt"));
  const openLibrary = tree.getTreeItem(si).command!;
  await vscode.commands.executeCommand(openLibrary.command, ...openLibrary.arguments!);
  assert.notEqual(vscode.window.activeTextEditor!.document.uri.scheme, "file");
  assert(vscode.window.activeTextEditor!.document.getText().includes("package SI"));
  assert.equal(
    tree.current?.uri.toString(),
    a.uri.toString(),
    "Browsing must not switch the selected project",
  );

  const bUri = vscode.Uri.joinPath(b.uri, "system.sysml");
  await eventually(
    async () => vscode.languages.getDiagnostics(bUri),
    (diagnostics) =>
      diagnostics.some(
        (d) => d.severity === vscode.DiagnosticSeverity.Error && d.message.includes("Battery"),
      ),
  );

  await vscode.commands.executeCommand("dryas.selectProject", a);
  // Editor focus is on B. Commands must still use the explicitly selected A.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(bUri));
  await vscode.commands.executeCommand("dryas.validateProject");
  const validation = JSON.parse(vscode.window.activeTextEditor!.document.getText());
  assert.equal(validation.project.errors, 0);
  await vscode.commands.executeCommand("dryas.showMcpConfiguration");
  const config = JSON.parse(vscode.window.activeTextEditor!.document.getText()).mcpServers.dryas;
  assert.equal(config.args[config.args.indexOf("--project") + 1], a.uri.fsPath);
  assert.equal(config.args[config.args.indexOf("--model-root") + 1], ".");
  await vscode.commands.executeCommand("dryas.selectProject", b);
  const client = new Client({ name: "systrace-project-host-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "validate", arguments: {} });
    assert(!response.isError);
    const report = response.structuredContent as {
      project: { errors: number };
      content: { files: { file: string }[] };
    };
    assert.equal(
      report.project.errors,
      0,
      "A's existing MCP binding must survive a UI switch to B",
    );
    const found = await client.callTool({ name: "find_element", arguments: { name: "Battery" } });
    assert(!found.isError);
    const elements = found.structuredContent as { items: { qualifiedName: string }[] };
    assert(elements.items.some((item) => item.qualifiedName === "Components::Battery"));
    assert.deepEqual(report.content.files.map((file) => file.file).sort(), [
      "definitions.sysml",
      "design/system.sysml",
    ]);
  } finally {
    await client.close();
  }

  const third = vscode.Uri.joinPath(a.uri, "..", "ProjectC");
  await vscode.workspace.fs.createDirectory(third);
  await vscode.commands.executeCommand("dryas.openProject", third);
  await eventually(
    async () => state.getLanguageServiceStatus(),
    (statuses) => statuses.length === 3 && statuses.every((s) => s.connection === "connected"),
  );
  const c = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.toString() === third.toString(),
  );
  assert(c);
  await vscode.commands.executeCommand("dryas.closeProject", c);
  await eventually(
    async () => state.getLanguageServiceStatus(),
    (statuses) => statuses.length === 2,
  );
  await vscode.workspace.fs.stat(third);
  console.log(
    "DRYAS host checks passed: dedicated sidebar, expandable source and library trees, unsaved outline refresh, source navigation, project-root discovery, nested sources, two-project completion/navigation/diagnostic isolation, explicit selection, stable MCP binding, open and close without deleting files.",
  );
}
