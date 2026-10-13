// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
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
  const state = extension.exports as { getLanguageServiceStatus(): { connection: string }[] };
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
    "DRYAS host checks passed: project-root discovery, nested sources, two-project completion/navigation/diagnostic isolation, explicit selection, stable MCP binding, open and close without deleting files.",
  );
}
