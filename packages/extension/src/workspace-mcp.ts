// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { join } from "node:path";
import type { ProjectOptions } from "@dryas/engine-adapter";

export function mcpArguments(extensionPath: string, config: ProjectOptions): string[] {
  const args = [
    join(extensionPath, "dist", "mcp.cjs"),
    "--project",
    config.projectRoot,
    "--engine",
    config.engine.executable,
  ];
  if (config.engine.expectedVersion) args.push("--expected-version", config.engine.expectedVersion);
  if (config.engine.timeoutMs !== undefined)
    args.push("--timeout-ms", String(config.engine.timeoutMs));
  for (const root of config.modelRoots ?? ["."]) args.push("--model-root", root);
  return args;
}

/** The host owns MCP connections, tool discovery, trust, status and enablement. */
export class WorkspaceMcp
  implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly numbers: Record<string, number>;
  private disposed = false;
  private revision = 0;
  readonly supported =
    typeof vscode.lm?.registerMcpServerDefinitionProvider === "function" &&
    typeof vscode.McpStdioServerDefinition === "function";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly options: (folder: vscode.WorkspaceFolder) => ProjectOptions,
  ) {
    this.numbers = {
      ...context.workspaceState.get<Record<string, number>>("dryas.mcpProjectNumbers", {}),
    };
    this.disposables.push(
      vscode.commands.registerCommand("dryas.manageMcpServers", () => this.manage()),
    );
    if (!this.supported) return;
    this.disposables.push(
      vscode.lm.registerMcpServerDefinitionProvider("systrace.workspace", this),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          ["apiPath", "expectedEngineVersion", "requestTimeoutMs", "modelRoots"].some((key) =>
            event.affectsConfiguration(`dryas.${key}`),
          )
        )
          this.refresh();
      }),
    );
  }

  private refresh(): void {
    this.revision++;
    this.changed.fire();
  }

  async provideMcpServerDefinitions(): Promise<vscode.McpStdioServerDefinition[]> {
    if (this.disposed || !this.supported || !vscode.workspace.isTrusted) return [];
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "file",
    );
    const revision = this.revision;
    let added = false;
    const definitions = folders.map((folder) => {
      const key = folder.uri.toString();
      if (!this.numbers[key]) {
        this.numbers[key] = Math.max(0, ...Object.values(this.numbers)) + 1;
        added = true;
      }
      const definition = new vscode.McpStdioServerDefinition(
        `Systrace: ${folder.name} [${this.numbers[key]}]`,
        process.execPath,
        mcpArguments(this.context.extensionPath, this.options(folder)),
        { ELECTRON_RUN_AS_NODE: "1" },
        this.context.extension.packageJSON.version,
      );
      definition.cwd = folder.uri;
      return definition;
    });
    if (added)
      await this.context.workspaceState.update("dryas.mcpProjectNumbers", { ...this.numbers });
    if (this.disposed || !vscode.workspace.isTrusted) return [];
    return revision === this.revision ? definitions : this.provideMcpServerDefinitions();
  }

  async resolveMcpServerDefinition(
    definition: vscode.McpStdioServerDefinition,
  ): Promise<vscode.McpStdioServerDefinition | undefined> {
    // A closed project or old definition must never retarget a queued tool call.
    const definitions = await this.provideMcpServerDefinitions();
    const root = definition.args[definition.args.indexOf("--project") + 1];
    return definitions.find(
      (current) =>
        current.label === definition.label &&
        current.args[current.args.indexOf("--project") + 1] === root,
    );
  }

  private async manage(): Promise<void> {
    if (
      this.supported &&
      (await vscode.commands.getCommands(true)).includes("workbench.mcp.listServer")
    ) {
      await vscode.commands.executeCommand("workbench.mcp.listServer");
      return;
    }
    await vscode.window.showInformationMessage(
      "This editor does not expose the VS Code MCP management interface. Use DRYAS: Show MCP Configuration with your agent's MCP settings.",
    );
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach((item) => item.dispose());
    this.changed.dispose();
  }
}
