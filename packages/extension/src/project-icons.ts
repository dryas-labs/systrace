// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { SymbolKind, Uri } from "vscode";
import type { OutlinePresentation } from "@dryas/engine-adapter";

/** Both native and detailed views use these same SVG assets and mappings. */
export function projectIconName(
  kind: string,
  presentation?: OutlinePresentation,
  symbolKind?: SymbolKind,
): string {
  if (kind === "project") return "project";
  if (kind === "source" || kind === "directory") return "folder";
  if (kind === "file") return "file";
  if (kind === "libraries") return "library";
  if (kind === "reference") return "project-reference";
  if (kind === "references") return "references-folder";
  if (kind === "message") return "message";
  if (kind === "namespace") return "package";
  if (presentation) {
    return presentation.role === "other"
      ? presentation.family
      : `${presentation.family}-${presentation.role}`;
  }
  if (symbolKind === SymbolKind.Namespace) return "namespace";
  if (symbolKind === SymbolKind.Package) return "package";
  return "other";
}

export function projectIconPaths(extensionPath = "", name: string): { light: Uri; dark: Uri } {
  return {
    light: Uri.file(join(extensionPath, "media", "tree-icons", "light", `${name}.svg`)),
    dark: Uri.file(join(extensionPath, "media", "tree-icons", "dark", `${name}.svg`)),
  };
}
