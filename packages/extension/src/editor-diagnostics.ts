// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { relative, sep } from "node:path";

export interface EditorConnection {
  project: number;
  name?: string;
  connection: string;
  index: "unconfirmed";
  message: string;
}

/** Snapshot the current window's Problems collection without asking LSP to recompute. */
export function observeEditorDiagnostics(
  projects: readonly EditorConnection[],
  librarySchemes: ReadonlySet<string>,
) {
  const documents = new Map(
    vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]),
  );
  const files = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
    const document = documents.get(uri.toString());
    const library = librarySchemes.has(uri.scheme);
    if (
      !library &&
      !["sysml", "kerml"].includes(document?.languageId ?? "") &&
      !/\.(sysml|kerml)$/i.test(uri.path)
    )
      return [];
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return [
      {
        uri: uri.toString(),
        file:
          folder && uri.scheme === "file"
            ? relative(folder.uri.fsPath, uri.fsPath).split(sep).join("/")
            : uri.path,
        project: folder?.name ?? null,
        library,
        unsaved: document?.isDirty ?? false,
        ...(document ? { documentVersion: document.version } : {}),
        diagnostics: diagnostics.map((diagnostic) => ({
          severity: (["error", "warning", "information", "hint"] as const)[diagnostic.severity],
          message: diagnostic.message,
          ...(diagnostic.tags ? { tags: [...diagnostic.tags] } : {}),
          ...(diagnostic.relatedInformation
            ? {
                relatedInformation: diagnostic.relatedInformation.map((information) => ({
                  message: information.message,
                  location: {
                    uri: information.location.uri.toString(),
                    range: {
                      start: {
                        line: information.location.range.start.line + 1,
                        column: information.location.range.start.character + 1,
                      },
                      end: {
                        line: information.location.range.end.line + 1,
                        column: information.location.range.end.character + 1,
                      },
                    },
                  },
                })),
              }
            : {}),
          range: {
            start: {
              line: diagnostic.range.start.line + 1,
              column: diagnostic.range.start.character + 1,
            },
            end: {
              line: diagnostic.range.end.line + 1,
              column: diagnostic.range.end.character + 1,
            },
          },
          ...(diagnostic.source ? { source: diagnostic.source } : {}),
          ...(diagnostic.code === undefined
            ? {}
            : {
                code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
              }),
        })),
      },
    ];
  });
  return {
    observation: "editor" as const,
    scope: "all-providers-sysml-kerml" as const,
    index: "unconfirmed" as const,
    positionEncoding: "utf-16" as const,
    positionBase: 1 as const,
    projects: projects.map((project) => ({ ...project, index: "unconfirmed" as const })),
    files,
  };
}
