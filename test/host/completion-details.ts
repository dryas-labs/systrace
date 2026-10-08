// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";

export async function checkCompletionDetails(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, "model", "completion-details.sysml");
  const text = `package CompletionDetails {
    part def Battery {
        doc /* First detail paragraph.
${"         * An intermediate documentation line.\n".repeat(20)}         * **Last detail paragraph.** */
        part child { doc /* CHILD DOCUMENTATION MUST NOT LEAK */ }
    }
    alias Cell for Battery;
    part def Plain;
}
package CompletionConsumer { part battery : CompletionDetails::Ce; }
`;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const offset = text.lastIndexOf("::Ce") + "::Ce".length;
  const position = document.positionAt(offset);
  let list: vscode.CompletionList | undefined;
  const deadline = Date.now() + 30000;
  do {
    // This small qualified namespace has three members. Resolving the top three
    // exercises the editor's actual completion resolve transport and conversion.
    list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      position,
      undefined,
      3,
    );
    if (list?.items.some((item) => item.documentation)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  assert(list, "The editor must return completion candidates.");
  const candidate = (label: string) => {
    const item = list.items.find(
      (item) => (typeof item.label === "string" ? item.label : item.label.label) === label,
    );
    assert(item, `Missing ${label} candidate.`);
    return item;
  };
  const prose = (item: vscode.CompletionItem) =>
    typeof item.documentation === "string" ? item.documentation : (item.documentation?.value ?? "");
  for (const name of ["Battery", "Cell"]) {
    const item = candidate(name);
    for (const expected of [
      "part def Battery",
      `CompletionDetails::${name}`,
      "Declaration: `CompletionDetails::Battery`",
      "completion-details.sysml",
      "First detail paragraph.",
      "**Last detail paragraph.**",
    ]) {
      assert(prose(item).includes(expected), `${name} completion documentation omits ${expected}.`);
    }
    assert(!prose(item).includes("CHILD DOCUMENTATION MUST NOT LEAK"));
  }
  const plain = prose(candidate("Plain"));
  assert(plain.includes("part def Plain"), "An undocumented element still has a signature.");
  assert(!plain.includes("detail paragraph"), "Undocumented elements must not borrow another doc.");
  const cell = candidate("Cell");
  assert(
    cell.insertText === undefined || cell.insertText === "Cell",
    "Resolving alias details must preserve the visible insertion spelling.",
  );
  const insert = new vscode.WorkspaceEdit();
  insert.replace(uri, new vscode.Range(document.positionAt(offset - 2), position), "Cell");
  assert(await vscode.workspace.applyEdit(insert));
  assert(await document.save());
  const definitions = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >("vscode.executeDefinitionProvider", uri, document.positionAt(offset));
  assert(
    definitions?.length,
    "The inserted alias must still support native definition navigation.",
  );
}
