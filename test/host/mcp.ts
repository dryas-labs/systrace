// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";
import type { WorkspaceMcp } from "../../packages/extension/src/workspace-mcp.js";

async function eventually<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 25000;
  do {
    const value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < until);
  throw new Error("Workspace MCP tools were not discovered by the host.");
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("dryas-labs.systrace");
  assert(extension);
  await extension.activate();
  const provider = (extension.exports as { getWorkspaceMcp(): WorkspaceMcp }).getWorkspaceMcp();
  assert(provider.supported, "The configured host must expose the native MCP provider API.");
  const definitions = await provider.provideMcpServerDefinitions();
  assert.equal(definitions.length, 2);
  const roots = definitions.map(
    (definition) => definition.args[definition.args.indexOf("--project") + 1],
  );
  assert.equal(new Set(roots).size, 2);
  // Native server IDs are host-specific; this mapping is confined to this
  // integration harness, never used by the extension's management UI.
  const nativeIds = definitions.map((definition) => `${extension.id}/${definition.label}`);
  try {
    for (const id of nativeIds)
      await vscode.commands.executeCommand("workbench.mcp.startServer", id);
    const validations = await eventually(
      () =>
        vscode.lm.tools.filter((tool) =>
          tool.description.startsWith("Validate every saved SysML/KerML source"),
        ),
      (tools) => tools.length === 2,
    );
    for (const description of [
      "Search the saved project",
      "Read an exact native qualified name",
      "Use an exact qualifiedName",
    ]) {
      assert.equal(
        vscode.lm.tools.filter((tool) => tool.description.startsWith(description)).length,
        2,
      );
    }
    const results = [];
    for (const tool of validations) {
      const result = await vscode.lm.invokeTool(tool.name, {
        input: {},
        toolInvocationToken: undefined,
      });
      const text = result.content
        .filter(
          (part): part is vscode.LanguageModelTextPart =>
            part instanceof vscode.LanguageModelTextPart,
        )
        .map((part) => part.value)
        .join("\n");
      results.push(JSON.parse(text));
    }
    assert.equal(new Set(results.map((result) => result.content.sessionId)).size, 2);
    assert.deepEqual(results.map((result) => result.project.errors > 0).sort(), [false, true]);
    assert((await vscode.commands.getCommands(true)).includes("workbench.mcp.listServer"));
    console.log(
      "DRYAS host checks passed: automatic workspace MCP registration, native tool discovery and isolated project validation.",
    );
  } finally {
    for (const id of nativeIds)
      await vscode.commands.executeCommand("workbench.mcp.stopServer", id);
  }
}
