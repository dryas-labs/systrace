// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Projects } from "../../packages/extension/src/projects.js";
import type { ContentNode, ProjectNode } from "../../packages/extension/src/project-tree.js";

async function eventually<T>(
  label: string,
  read: () => PromiseLike<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 30000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < until);
  throw new Error(`Project reference check timed out: ${label}`);
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("dryas-labs.systrace")!;
  await extension.activate();
  const state = extension.exports as {
    getLanguageServiceStatus(): { connection: string }[];
    getProjectTree(): Projects;
  };
  const [a, b] = vscode.workspace.workspaceFolders!;
  assert(a && b);
  const tree = state.getProjectTree();
  const children = async (node: ProjectNode) => (await tree.getChildren(node)) as ContentNode[];
  const connected = (count: number) =>
    eventually(
      "language services connected",
      async () => state.getLanguageServiceStatus(),
      (s) => s.length === count && s.every((item) => item.connection === "connected"),
    );
  await connected(2);
  const aUri = vscode.Uri.joinPath(a.uri, "system.sysml");
  const aDoc = await vscode.workspace.openTextDocument(aUri);
  await vscode.window.showTextDocument(aDoc, { preview: false });
  const position = aDoc.positionAt(aDoc.getText().indexOf(": Battery") + 4);
  const errors = () =>
    vscode.languages
      .getDiagnostics(aUri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  await eventually(
    "unreferenced definition rejected",
    async () => errors(),
    (ds) => ds.some((d) => d.message.includes("Battery")),
  );
  await tree.select(a);
  await tree.addReference(a, b);
  await connected(2);
  assert.equal(tree.current?.uri.toString(), a.uri.toString());
  const completion = () =>
    vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      aUri,
      position,
    );
  const has = (items: vscode.CompletionList, name: string) =>
    !!items?.items.some(
      (item) => (typeof item.label === "string" ? item.label : item.label.label) === name,
    );
  await eventually("imported Battery completion", completion, (items) => has(items, "Battery"));
  await eventually(
    "consumer diagnostics clear",
    async () => errors(),
    (ds) => ds.length === 0,
  );
  const locations = await eventually(
    "definition in dependency",
    () =>
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        aUri,
        position,
      ),
    (items) => !!items?.length,
  );
  const target = "uri" in locations[0]! ? locations[0].uri : locations[0]!.targetUri;
  assert(target.scheme.startsWith("systrace-reference-"));
  const referenceDoc = await vscode.workspace.openTextDocument(target);
  assert(referenceDoc.getText().includes("part def Battery"));
  await vscode.window.showTextDocument(referenceDoc, { preview: false });
  assert.equal(tree.current?.uri.toString(), a.uri.toString());
  const group = (await children(a)).find((node) => node.nodeType === "references")!;
  const referenceNode = (await children(group))[0]!;
  assert.equal(tree.getTreeItem(referenceNode).contextValue, "systraceProjectReference");
  const source = (await children(referenceNode)).find((node) => node.label === "library")!;
  const file = (await children(source)).find((node) => node.label === "components.sysml")!;
  assert.equal(file.uri?.toString(), target.toString());
  assert.equal(tree.getTreeItem(file).contextValue, "systraceReadOnlyReference");
  assert((await children(file)).some((node) => node.label === "Components"));

  await vscode.commands.executeCommand("dryas.showMcpConfiguration");
  const config = JSON.parse(vscode.window.activeTextEditor!.document.getText()).mcpServers.dryas;
  const client = new Client({ name: "systrace-reference-host-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  type Report = {
    project: { errors: number };
    content: {
      projectRevision: number;
      references?: { project: string }[];
      files: { file: string }[];
    };
  };
  type Found = { items: { qualifiedName: string }[] };
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const answer = await client.callTool({ name, arguments: args });
    assert(!answer.isError, `MCP ${name} failed: ${JSON.stringify(answer.content)}`);
    return answer.structuredContent as T;
  };
  try {
    await client.connect(transport);
    const before = await call<Report>("validate");
    assert.equal(before.project.errors, 0);
    assert.deepEqual(before.content.references?.map((ref) => ref.project).sort(), [
      "Components",
      "Foundation",
    ]);
    assert.equal(before.content.files.length, 3);
    assert(
      (await call<Found>("find_element", { name: "BaseBattery" })).items.some(
        (item) => item.qualifiedName === "Foundation::BaseBattery",
      ),
    );
    assert.equal(
      (
        await call<{ items: { element: { qualifiedName: string } }[] }>("describe_element", {
          qualifiedName: "Components::Battery",
        })
      ).items[0]?.element.qualifiedName,
      "Components::Battery",
    );

    const bUri = vscode.Uri.joinPath(b.uri, "library/components.sysml");
    const bDoc = await vscode.workspace.openTextDocument(bUri);
    await vscode.window.showTextDocument(bDoc);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(bUri, bDoc.positionAt(bDoc.getText().lastIndexOf("}")), "part def BatteryExtra; ");
    assert(await vscode.workspace.applyEdit(edit));
    assert(bDoc.isDirty);
    const bPosition = bDoc.positionAt(bDoc.getText().indexOf("BatteryExtra") + 3);
    await eventually(
      "producer sees its unsaved definition",
      () =>
        vscode.commands.executeCommand<vscode.CompletionList>(
          "vscode.executeCompletionItemProvider",
          bUri,
          bPosition,
        ),
      (items) => has(items, "BatteryExtra"),
    );
    assert(
      !has(await completion(), "BatteryExtra"),
      "Unsaved dependency edits must not enter the consumer",
    );
    assert(!(await call<Found>("find_element", { name: "BatteryExtra" })).items.length);
    assert(!referenceDoc.getText().includes("BatteryExtra"));
    await bDoc.save();
    await eventually("saved dependency completion", completion, (items) =>
      has(items, "BatteryExtra"),
    );
    await eventually(
      "read-only source refreshed",
      async () => referenceDoc.getText(),
      (text) => text.includes("BatteryExtra"),
    );
    assert(
      (await call<Found>("find_element", { name: "BatteryExtra" })).items.some(
        (item) => item.qualifiedName === "Components::BatteryExtra",
      ),
    );
    assert(
      (await call<Report>("validate")).content.projectRevision > before.content.projectRevision,
    );

    await tree.close(b);
    await connected(1);
    assert(has(await completion(), "Battery"), "Closing B must not remove A's declared reference");
    assert.equal((await call<Report>("validate")).project.errors, 0);
    // Exercise a watcher outside all open workspace folders, not only B's own editor.
    await vscode.workspace.fs.writeFile(
      bUri,
      Buffer.from(bDoc.getText().replace("BatteryExtra", "BatterySaved")),
    );
    await eventually(
      "closed dependency update",
      completion,
      (items) => has(items, "BatterySaved") && !has(items, "BatteryExtra"),
    );
    assert((await call<Found>("find_element", { name: "BatterySaved" })).items.length);

    const saved = bDoc.getText().replace("BatteryExtra", "BatterySaved");
    await vscode.workspace.fs.writeFile(
      bUri,
      Buffer.from(saved.replace("BaseBattery;", "MissingDependency;")),
    );
    const broken = await call<Report & { diagnostics: { file: string; message: string }[] }>(
      "validate",
    );
    assert(
      broken.diagnostics.some(
        (d) => d.file === ".references/..%2FComponents/library/components.sysml",
      ),
      "Dependency errors must retain their reference file identity",
    );
    await vscode.workspace.fs.delete(bUri);
    await eventually(
      "deleted dependency stops resolving",
      completion,
      (items) => !has(items, "Battery"),
    );
    await eventually(
      "deleted dependency diagnosed",
      async () => errors(),
      (ds) => ds.some((d) => d.message.includes("Battery")),
    );
    await vscode.workspace.fs.writeFile(bUri, Buffer.from(saved));
    await eventually("restored dependency resolves", completion, (items) => has(items, "Battery"));
    assert.equal((await call<Report>("validate")).project.errors, 0);

    await tree.removeReference(referenceNode);
    await connected(1);
    await eventually(
      "removed reference no longer resolves",
      async () => errors(),
      (ds) => ds.some((d) => d.message.includes("Battery")),
    );
    assert(!has(await completion(), "Battery"));
    const after = await call<Report>("validate");
    assert(after.project.errors > 0);
    assert.equal(after.content.files.length, 1);
    assert(!after.content.references?.length);
    assert(!(await call<Found>("find_element", { name: "Battery" })).items.length);
    await vscode.workspace.fs.stat(bUri);
  } finally {
    await client.close();
  }
  console.log(
    "DRYAS host checks passed: declared and transitive project references, native completion and definition, read-only dependency tree, saved-only isolation, saved updates with dependency open and closed, MCP validation/find/describe and scope refresh, dependency error locations and deletion/restoration, reference removal without deleting files.",
  );
}
