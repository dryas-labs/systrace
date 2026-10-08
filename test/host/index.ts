// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { checkStandardLibraryNavigation } from "./stdlib.js";
import { checkDocumentationEditing } from "./documentation.js";
import { checkCompletionDetails } from "./completion-details.js";

async function eventually<T>(
  read: () => PromiseLike<T>,
  accept: (value: T) => boolean,
  message = "The extension did not produce the expected language feature.",
): Promise<T> {
  const until = Date.now() + 30000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < until);
  throw new Error(message);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("dryas-labs.systrace");
  assert(extension, "DRYAS extension is installed");
  await extension.activate();
  const status = () =>
    (
      extension.exports as {
        getLanguageServiceStatus(): {
          generation: number;
          connection: string;
          index: string;
          errorCode?: string;
          message: string;
        }[];
      }
    ).getLanguageServiceStatus();
  assert.equal(status()[0]?.connection, "connected");
  assert.equal(
    status()[0]?.index,
    "unconfirmed",
    "Handshake success must not imply complete indexing",
  );
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert(folder);
  const uri = vscode.Uri.joinPath(folder.uri, "model", "system.sysml");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const typeOffset = document.getText().indexOf(": Battery") + 2;
  assert(typeOffset > 1, "Fixture contains the Battery type reference");
  const position = document.positionAt(typeOffset + 2);
  await eventually(
    () =>
      vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, position),
    (result) => !!result?.length,
  );
  await eventually(
    () =>
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        uri,
        position,
      ),
    (result) =>
      !!result?.some((location) =>
        ("uri" in location ? location.uri : location.targetUri).path.endsWith("/definitions.sysml"),
      ),
  );
  const replace = new vscode.WorkspaceEdit();
  const start = document.positionAt(typeOffset);
  replace.replace(
    uri,
    new vscode.Range(start, start.translate(0, "Battery".length)),
    "MissingType",
  );
  assert(await vscode.workspace.applyEdit(replace));
  await eventually(
    async () => vscode.languages.getDiagnostics(uri),
    (list) => list.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
  );
  await vscode.commands.executeCommand("undo");
  await eventually(
    async () => vscode.languages.getDiagnostics(uri),
    (list) => !list.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
  );
  const completionPosition = document.positionAt(
    document.getText().indexOf("Components::") + "Components::".length,
  );
  await eventually(
    () =>
      vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        completionPosition,
      ),
    (result) =>
      !!result?.items.some(
        (item) => (typeof item.label === "string" ? item.label : item.label.label) === "Battery",
      ),
    "Qualified completion must offer the imported Battery definition.",
  );
  const original = document.getText();
  const insert = new vscode.WorkspaceEdit();
  insert.insert(
    uri,
    document.positionAt(original.lastIndexOf("}")),
    "    part secondaryBattery : Ba;\n",
  );
  assert(await vscode.workspace.applyEdit(insert));
  const partialOffset =
    document.getText().lastIndexOf("secondaryBattery : Ba;") + "secondaryBattery : ".length;
  const partialPosition = document.positionAt(partialOffset + 2);
  const importedCompletion = await eventually(
    () =>
      vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        partialPosition,
      ),
    (result) =>
      !!result?.items.some(
        (item) =>
          (typeof item.label === "string" ? item.label : item.label.label) === "Battery" &&
          item.kind === vscode.CompletionItemKind.Class,
      ),
    "Typing Ba in an unqualified type position must offer the imported Battery definition, not only the battery usage.",
  );
  assert(importedCompletion.items.length > 0);
  const acceptCompletion = new vscode.WorkspaceEdit();
  acceptCompletion.replace(
    uri,
    new vscode.Range(document.positionAt(partialOffset), partialPosition),
    "Battery",
  );
  assert(await vscode.workspace.applyEdit(acceptCompletion));
  await eventually(
    () =>
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        uri,
        document.positionAt(partialOffset + 2),
      ),
    (result) =>
      !!result?.some((location) =>
        ("uri" in location ? location.uri : location.targetUri).path.endsWith("/definitions.sysml"),
      ),
    "The accepted Battery completion must resolve to its cross-file definition.",
  );
  const restore = new vscode.WorkspaceEdit();
  restore.replace(
    uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
    original,
  );
  assert(await vscode.workspace.applyEdit(restore));
  assert(await document.save());
  await vscode.commands.executeCommand("dryas.validateProject");
  const report = vscode.window.activeTextEditor?.document.getText();
  assert(
    report && JSON.parse(report).project.errors === 0,
    "Saved-project command returns zero native errors",
  );
  const settings = vscode.workspace.getConfiguration("dryas", folder.uri);
  await settings.update(
    "modelRoots",
    ["missing-model-folder"],
    vscode.ConfigurationTarget.Workspace,
  );
  const missingRoot = await eventually(
    async () => status()[0],
    (state) => state?.errorCode === "INVALID_PATH",
  );
  assert(missingRoot?.message.includes("dryas.modelRoots"));
  await settings.update("modelRoots", ["model"], vscode.ConfigurationTarget.Workspace);
  await eventually(
    async () => status()[0],
    (state) => state?.connection === "connected",
    "Correcting model roots must recover the language service without reloading the editor.",
  );
  const checkLibraryAfterRestart = await checkStandardLibraryNavigation(folder);
  await checkDocumentationEditing(folder);
  await checkCompletionDetails(folder);
  const beforeBurst = status()[0]!.generation;
  for (const timeout of [20000, 21000, 22000])
    await settings.update("requestTimeoutMs", timeout, vscode.ConfigurationTarget.Workspace);
  await eventually(
    async () => status()[0],
    (state) => state?.connection === "connected" && state.generation > beforeBurst,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(status()[0]!.generation, beforeBurst + 1, "A settings burst restarts once");
  await settings.update("lspPath", settings.get("lspPath"), vscode.ConfigurationTarget.Workspace);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(
    status()[0]!.generation,
    beforeBurst + 1,
    "An unchanged effective path does not restart",
  );
  await settings.update("apiPath", "dryas-test-missing-api", vscode.ConfigurationTarget.Workspace);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(
    status()[0]!.generation,
    beforeBurst + 1,
    "An API-only change leaves the LSP running",
  );
  await settings.update("apiPath", undefined, vscode.ConfigurationTarget.Workspace);
  await settings.update("lspPath", '"quoted-executable"', vscode.ConfigurationTarget.Workspace);
  await eventually(
    async () => status()[0],
    (state) => state?.errorCode === "INVALID_EXECUTABLE",
  );
  await settings.update("lspPath", undefined, vscode.ConfigurationTarget.Workspace);
  await eventually(
    async () => status()[0],
    (state) => state?.connection === "connected",
  );
  const beforeManual = status()[0]!.generation;
  await vscode.commands.executeCommand("dryas.restartLanguageServer");
  assert.equal(status()[0]!.generation, beforeManual + 1);
  await checkLibraryAfterRestart();
  await eventually(
    () =>
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        uri,
        position,
      ),
    (result) =>
      !!result?.some((location) =>
        ("uri" in location ? location.uri : location.targetUri).path.endsWith("/definitions.sysml"),
      ),
  );
  console.log(
    "DRYAS host checks passed: activation, language features, saved validation, coalesced settings, explicit configuration errors and restart recovery.",
  );
}
