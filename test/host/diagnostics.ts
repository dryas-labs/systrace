// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("dryas-labs.systrace");
  assert(extension);
  await extension.activate();
  assert(vscode.lm.tools.some((tool) => tool.name === "dryas_editor_diagnostics"));
  const document = await vscode.workspace.openTextDocument({
    language: "sysml",
    content: "package Draft;",
  });
  const collection = vscode.languages.createDiagnosticCollection("diagnostic-observation-check");
  collection.set(document.uri, [
    new vscode.Diagnostic(
      new vscode.Range(0, 3, 0, 5),
      "Observation fixture",
      vscode.DiagnosticSeverity.Hint,
    ),
  ]);
  try {
    const result = await vscode.lm.invokeTool("dryas_editor_diagnostics", {
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
    const report = JSON.parse(text);
    assert.equal(report.observation, "editor");
    assert(report.projects.every((project: { index: string }) => project.index === "unconfirmed"));
    assert(
      report.files.some(
        (file: { uri: string; unsaved: boolean; diagnostics: { severity: string }[] }) =>
          file.uri === document.uri.toString() &&
          file.unsaved &&
          file.diagnostics.some((diagnostic) => diagnostic.severity === "hint"),
      ),
    );
    const commands = await vscode.commands.getCommands(true);
    assert(
      !commands.includes("dryas.manageMcpServers") &&
        !commands.includes("dryas.showMcpConfiguration"),
    );
    console.log(
      "DRYAS host checks passed: native Copilot tool discovery and current-window unsaved diagnostic observation.",
    );
  } finally {
    collection.dispose();
  }
}
