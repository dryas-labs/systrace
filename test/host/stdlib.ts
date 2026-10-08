// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import assert from "node:assert/strict";

type Target = vscode.Location | vscode.LocationLink;

async function definition(document: vscode.TextDocument, needle: string): Promise<Target> {
  const offset = document.getText().indexOf(needle);
  assert(offset >= 0, "The navigation fixture contains its reference.");
  const position = document.positionAt(offset + needle.length - 1);
  const deadline = Date.now() + 30000;
  do {
    const targets = await vscode.commands.executeCommand<Target[]>(
      "vscode.executeDefinitionProvider",
      document.uri,
      position,
    );
    if (targets?.length) return targets[0]!;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(
    "A standard-library definition must resolve, including inside library documents.",
  );
}

function targetUri(target: Target): vscode.Uri {
  return "uri" in target ? target.uri : target.targetUri;
}

async function openTarget(target: Target, declaration: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(targetUri(target));
  const range = "uri" in target ? target.range : target.targetRange;
  assert(
    document.getText(range).includes(declaration),
    "The returned range must match the bundled source.",
  );
  await vscode.window.showTextDocument(document, { selection: range });
  return document;
}

export async function checkStandardLibraryNavigation(
  folder: vscode.WorkspaceFolder,
): Promise<() => Promise<void>> {
  const uri = vscode.Uri.joinPath(folder.uri, "model", "library-navigation.sysml");
  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(`package StandardLibraryNavigation {
    private import SI::*;
    port def PowerPort;
    part def Battery { port output : PowerPort; }
    part def Battery48V :> Battery {
        attribute outputVoltage redefines ISQ::voltage = 48[V];
    }
    attribute count : ScalarValues::Integer;
}
`),
  );
  const source = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(source);
  const voltagePosition = source.positionAt(
    source.getText().indexOf("ISQ::voltage") + "ISQ::vol".length,
  );
  const voltage = await definition(source, "ISQ::voltage");
  assert(targetUri(voltage).path.endsWith("/ISQElectromagnetism.sysml"));
  const library = await openTarget(voltage, "voltage");
  const voltageHover = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    source.uri,
    voltagePosition,
  );
  const prose = (voltageHover ?? [])
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === "string" ? content : content.value))
    .join("\n");
  for (const marker of [
    "source: item 6-11.3",
    "measurement unit(s): V",
    "remarks: For an electric field",
    "121-11-27.",
  ])
    assert(prose.includes(marker), `Ordinary voltage hover omits ${marker}.`);
  assert.equal(library.languageId, "sysml");
  assert.notEqual(
    library.uri.scheme,
    "file",
    "Bundled libraries must not become editable workspace files.",
  );

  const integer = await definition(source, "ScalarValues::Integer");
  const kernel = await openTarget(integer, "Integer");
  assert.equal(kernel.languageId, "kerml");
  const dataValue = await definition(kernel, "Base::DataValue");
  assert(targetUri(dataValue).path.endsWith("/Base.kerml"));
  await openTarget(dataValue, "DataValue");

  const text = library.getText();
  await vscode.window.showTextDocument(library);
  await vscode.commands.executeCommand("default:type", { text: "must not be written" });
  assert.equal(library.getText(), text, "The standard-library editor must stay read-only.");
  assert.equal(library.isDirty, false);

  return async () => {
    const next = await definition(source, "ISQ::voltage");
    assert.equal(
      targetUri(next).toString(),
      library.uri.toString(),
      "A restart keeps library document identity.",
    );
    await openTarget(next, "voltage");
    const nested = await definition(kernel, "Base::DataValue");
    await openTarget(nested, "DataValue");
    const offset = library.getText().indexOf("attribute voltage") + "attribute ".length;
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      library.uri,
      library.positionAt(offset),
    );
    assert(hover?.length, "Hover within the standard library survives a server restart.");
  };
}
