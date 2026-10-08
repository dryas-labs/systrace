// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 30000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(message);
}

export async function checkDocumentationEditing(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, "model", "documentation.sysml");
  const text = `package DocumentationChecks {
    part def Battery {
        doc /*
         * First documentation paragraph.
${"         * A line of documentation.\n".repeat(20)}         * **Last documentation paragraph.**
         * Battery text this
         */
        part child { doc /* Child-only documentation. */ }
    }
    part battery : Battery;
}
`;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.equal(
    vscode.workspace.getConfiguration("editor", document).get("wordBasedSuggestions"),
    "off",
    "SysML defaults must not add dictionary words after the native provider returns no candidates.",
  );
  const typePosition = document.positionAt(text.lastIndexOf(": Battery") + ": Bat".length);
  await eventually(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      typePosition,
    );
    const value = (hovers ?? [])
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === "string" ? content : content.value))
      .join("\n");
    return (
      value.includes("First documentation paragraph.") &&
      value.includes("**Last documentation paragraph.**") &&
      !value.includes("Child-only documentation.")
    );
  }, "Ordinary hover must contain the full owned doc without child documentation.");
  await eventually(async () => {
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      typePosition,
    );
    return !!completion?.items.some(
      (item) => (typeof item.label === "string" ? item.label : item.label.label) === "Battery",
    );
  }, "Code completion must remain available outside the doc body.");
  const commentPosition = document.positionAt(
    text.indexOf("Battery text this") + "Battery text this".length,
  );
  const result = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    uri,
    commentPosition,
  );
  assert.equal(result?.items.length ?? 0, 0, "A doc body must not offer code symbols.");

  const unfinished = "package DocumentationChecks { part def Battery; doc /* incomplete th";
  const replace = new vscode.WorkspaceEdit();
  replace.replace(
    uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(text.length)),
    unfinished,
  );
  assert(await vscode.workspace.applyEdit(replace));
  await eventually(async () => {
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      document.positionAt(unfinished.length),
    );
    return (completion?.items.length ?? 0) === 0;
  }, "Code completion must stay suppressed while the documentation body is unfinished.");
  const restore = new vscode.WorkspaceEdit();
  restore.replace(
    uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(unfinished.length)),
    text,
  );
  assert(await vscode.workspace.applyEdit(restore));
  assert(await document.save());
  await eventually(async () => {
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      typePosition,
    );
    return !!completion?.items.some(
      (item) => (typeof item.label === "string" ? item.label : item.label.label) === "Battery",
    );
  }, "Closing the documentation and returning to code must restore completion.");
}
