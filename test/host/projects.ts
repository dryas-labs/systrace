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
  const files = await children(a);
  const library = files.find((node) => node.nodeType === "libraries");
  assert(library);
  assert(
    !files.some((node) => node.nodeType === "source"),
    "Default sources must be directly under the project",
  );
  assert(
    manifest.contributes.commands.some(
      (command: { command: string }) => command.command === "dryas.newNamespace",
    ),
  );
  assert(!files.some((node) => node.label === "notes.md"));
  const definitions = files.find((node) => node.label === "definitions.sysml");
  const design = files.find((node) => node.label === "design");
  assert(definitions && design);
  assert.equal(tree.getParent(definitions), a);
  assert((await children(design)).some((node) => node.label === "system.sysml"));
  const packageNode = (await children(definitions)).find((node) => node.label === "Components");
  assert(packageNode);
  const battery = (await children(packageNode)).find((node) => node.label === "Battery");
  assert(battery);
  assert.equal(tree.getTreeItem(battery).description, "part def");
  const output = (await children(battery)).find((node) => node.label === "output");
  assert(output);
  assert.equal(tree.getTreeItem(output).label, "output : PowerPort");
  assert.equal(tree.getTreeItem(output).description, "port");
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

  const settings = vscode.workspace.getConfiguration("dryas");
  assert.equal(settings.get("projectTree.displayMode"), "compact");
  const generations = state
    .getLanguageServiceStatus()
    .map((entry) => (entry as { generation?: number }).generation);
  await settings.update("projectTree.displayMode", "detailed", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("systrace.projectsDetailed.focus");
  await eventually(
    async () => tree.detailedView.getState(),
    (view) => view.visible && view.ready && view.items > 0,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(
    state.getLanguageServiceStatus().map((entry) => (entry as { generation?: number }).generation),
    generations,
    "Display preferences must not restart language services",
  );
  await settings.update("projectTree.displayMode", "compact", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("systrace.projects.focus");

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
  for (const directory of ["architecture", "requirements", ".vscode"])
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(third, directory));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(third, ".vscode/settings.json"),
    Buffer.from(JSON.stringify({ "dryas.modelRoots": ["architecture", "requirements"] })),
  );
  await vscode.commands.executeCommand("dryas.openProject", third);
  await eventually(
    async () => state.getLanguageServiceStatus(),
    (statuses) => statuses.length === 3 && statuses.every((s) => s.connection === "connected"),
  );
  const c = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.toString() === third.toString(),
  );
  assert(c);
  const cases = [
    ["requirements", "Hello", "Hello"],
    ["architecture", "part", "'part'"],
    ["requirements", "Power System", "'Power System'"],
    ["requirements", "系统", "'系统'"],
  ];
  for (const [directory, name, spelling] of cases) {
    const source = await tree.prepareNamespace(c, name!);
    assert.equal(source, `package ${spelling} {\n\n}\n`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(third, directory!, `${name}.sysml`),
      Buffer.from(source),
    );
  }
  // The current native outline reports an escaped label for an embedded apostrophe.
  // Do not silently interpret that label as the requested model name.
  await assert.rejects(() => tree.prepareNamespace(c, "O'Brien"), { code: "QUERY_UNAVAILABLE" });
  const sourceFolders = await children(c);
  assert.deepEqual(
    sourceFolders.map((node) => node.label),
    ["architecture", "requirements", "Project References", "Standard Library"],
  );
  for (const [directory, name] of cases) {
    const folder = sourceFolders.find((node) => node.label === directory)!;
    const file = (await children(folder)).find((node) => node.label === `${name}.sysml`)!;
    assert(file);
    await eventually(
      () => children(file),
      (nodes) => nodes.some((node) => node.label === name),
    );
  }
  const scratchSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    "__systrace_namespace_",
  );
  assert(!scratchSymbols?.length, "Namespace check buffers must be closed after use");
  assert(
    !vscode.languages.getDiagnostics().some(([uri]) => uri.path.includes("/namespace-check-")),
    "Temporary candidate diagnostics must stay out of Problems",
  );
  await vscode.commands.executeCommand("dryas.validateProject", c);
  assert.equal(
    JSON.parse(vscode.window.activeTextEditor!.document.getText()).project.errors,
    0,
    "Generated namespaces must pass native validation",
  );
  const requirements = sourceFolders.find((node) => node.label === "requirements")!;
  const removable = (await children(requirements)).find((node) => node.label === "Hello.sysml")!;
  assert.equal(tree.getTreeItem(removable).contextValue, "systraceNamespaceFile");
  assert(
    manifest.contributes.menus["view/item/context"].some(
      (item: { command: string; when: string }) =>
        item.command === "dryas.deleteNamespace" && item.when.includes("systraceNamespaceFile"),
    ),
  );
  const removableUri = removable.uri!;
  assert.equal(vscode.workspace.getWorkspaceFolder(removableUri)?.uri.toString(), c.uri.toString());
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(removableUri));
  // Confirmation/Cancel paths are exercised in project command tests. Here the
  // real editor file operation verifies tree and language-service propagation.
  const deletion = new vscode.WorkspaceEdit();
  deletion.deleteFile(removableUri, { recursive: false, ignoreIfNotExists: false });
  assert(await vscode.workspace.applyEdit(deletion));
  await assert.rejects(async () => vscode.workspace.fs.stat(removableUri));
  await eventually(
    () => children(requirements),
    (nodes) => !nodes.some((node) => node.label === "Hello.sysml"),
  );
  await eventually(
    () =>
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        "Hello",
      ),
    (symbols) =>
      !symbols?.some((symbol) => symbol.location.uri.toString() === removableUri.toString()),
  );
  await vscode.commands.executeCommand("dryas.validateProject", c);
  const afterDeletion = JSON.parse(vscode.window.activeTextEditor!.document.getText());
  assert(
    !afterDeletion.content.files.some(
      (file: { file: string }) => file.file === "requirements/Hello.sysml",
    ),
  );
  await vscode.commands.executeCommand("dryas.closeProject", c);
  await eventually(
    async () => state.getLanguageServiceStatus(),
    (statuses) => statuses.length === 2,
  );
  await vscode.workspace.fs.stat(third);
  console.log(
    "DRYAS host checks passed: namespace-file deletion propagation, flat project sources, named source folders, LSP-checked namespace spellings, dedicated sidebar, expandable source and library trees, unsaved outline refresh, source navigation, project-root discovery, nested sources, two-project completion/navigation/diagnostic isolation, explicit selection, stable MCP binding, open and close without deleting files.",
  );
}
