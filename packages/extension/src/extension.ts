// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LanguageClient, CloseAction, ErrorAction } from "vscode-languageclient/node";
import {
  ProjectSession,
  readSnapshot,
  publicError,
  engineEnvironment,
  ENGINE_VERSION,
  AdapterError,
  type ProjectOptions,
} from "@dryas/engine-adapter";
import { RefreshQueue, type RefreshReason } from "./refresh.js";
import { StdlibDocuments } from "./stdlib.js";
import {
  checkExecutableSetting,
  sameConfig,
  sameLanguageConfig,
  startupError,
  verifyLanguageServer,
  type ProjectConfig,
  type StartupStage,
} from "./startup.js";

interface RunningProject {
  client: LanguageClient;
  session: ProjectSession;
  watchers: vscode.FileSystemWatcher[];
  config: ProjectConfig;
  child?: ChildProcess;
  stopping: boolean;
  failed?: AdapterError;
}

interface ServiceStatus {
  project: number;
  connection: "starting" | "connected" | "stopped" | "error";
  index: "unconfirmed";
  stage: string;
  reason: string;
  generation: number;
  errorCode?: string;
  message: string;
}
let manager: Manager | undefined;

function options(folder: vscode.WorkspaceFolder): ProjectOptions & { lspPath: string } {
  const settings = vscode.workspace.getConfiguration("dryas", folder.uri);
  return {
    projectRoot: folder.uri.fsPath,
    modelRoots: settings.get<string[]>("modelRoots", ["model"]),
    lspPath:
      settings.get<string>("lspPath", "sysml-lsp") === "sysml-lsp"
        ? (process.env.DRYAS_LSP_PATH ?? "sysml-lsp")
        : settings.get<string>("lspPath")!,
    engine: {
      executable:
        settings.get<string>("apiPath", "sysml-grpc") === "sysml-grpc"
          ? (process.env.DRYAS_API_PATH ?? "sysml-grpc")
          : settings.get<string>("apiPath")!,
      expectedVersion: settings.get<string>("expectedEngineVersion", ENGINE_VERSION),
      timeoutMs: settings.get<number>("requestTimeoutMs", 30000),
    },
  };
}

class Manager {
  private readonly projects = new Map<string, RunningProject>();
  private readonly libraries = new Map<string, StdlibDocuments>();
  private readonly attempted = new Map<string, ProjectConfig>();
  private readonly statuses = new Map<string, ServiceStatus>();
  private readonly recoveries = new Map<string, number>();
  private readonly pendingRecovery = new Set<string>();
  private readonly output = vscode.window.createOutputChannel("DRYAS", { log: true });
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10,
  );
  private readonly refreshQueue = new RefreshQueue(
    (reasons) => this.reconcile(reasons),
    () =>
      this.output.error(
        "REFRESH_FAILED: Project connections could not be refreshed. Use DRYAS: Restart Language Server to retry.",
      ),
  );
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.name = "DRYAS language service";
    this.statusBar.command = "dryas.showLanguageServiceStatus";
    context.subscriptions.push(
      this.output,
      this.statusBar,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          ["lspPath", "apiPath", "modelRoots", "expectedEngineVersion", "requestTimeoutMs"].some(
            (key) => e.affectsConfiguration(`dryas.${key}`),
          )
        )
          void this.refresh("configuration", 750);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refresh("workspace");
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.refresh("trust");
      }),
      vscode.workspace.onDidOpenTextDocument((d) => {
        if (["sysml", "kerml"].includes(d.languageId)) void this.refresh("document-opened");
      }),
      vscode.commands.registerCommand("dryas.restartLanguageServer", () =>
        this.refresh("manual-restart"),
      ),
      vscode.commands.registerCommand("dryas.showLanguageServiceStatus", () => this.showStatus()),
      vscode.commands.registerCommand("dryas.validateProject", () => this.validate()),
      vscode.commands.registerCommand("dryas.showMcpConfiguration", () =>
        this.showMcpConfiguration(),
      ),
    );
  }

  refresh(reason: RefreshReason, delay = 0): Promise<void> {
    return this.refreshQueue.request(reason, delay);
  }

  getStatus(): ServiceStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }));
  }

  private async libraryFor(key: string): Promise<StdlibDocuments> {
    const existing = this.libraries.get(key);
    if (existing) return existing;
    // Persist an opaque identity in editor workspace storage so restored tabs
    // retain their owning project without exposing its filesystem path in URIs.
    const stateKey = `dryas.stdlib.${key}`;
    const saved = this.context.workspaceState.get<string>(stateKey);
    const scheme =
      saved && /^dryas-stdlib-[a-f0-9-]{36}$/.test(saved) ? saved : `dryas-stdlib-${randomUUID()}`;
    if (scheme !== saved) await this.context.workspaceState.update(stateKey, scheme);
    const library = new StdlibDocuments(scheme);
    this.libraries.set(key, library);
    return library;
  }

  private setStatus(key: string, status: ServiceStatus): void {
    this.statuses.set(key, status);
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (this.disposed) return;
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const status = folder
      ? this.statuses.get(folder.uri.toString())
      : this.statuses.size === 1
        ? this.statuses.values().next().value
        : undefined;
    if (!status) {
      this.statusBar.hide();
      return;
    }
    const label =
      status.connection === "starting"
        ? "$(sync~spin) DRYAS: Connecting"
        : status.connection === "connected"
          ? "$(plug) DRYAS: Connected"
          : status.connection === "error"
            ? "$(warning) DRYAS: Connection failed"
            : "$(circle-slash) DRYAS: Disconnected";
    this.statusBar.text = label;
    this.statusBar.tooltip = `${status.message}\nClick for language-service status. No complete-index signal is available from this engine.`;
    this.statusBar.show();
  }

  private async showStatus(): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        {
          projects: this.getStatus(),
          note: "Connected means the LSP handshake succeeded. Index completion is unconfirmed; it is not a model-validation result.",
        },
        null,
        2,
      ),
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async reconcile(reasons: ReadonlySet<RefreshReason>): Promise<void> {
    if (this.disposed || !vscode.workspace.isTrusted) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (f) => f.uri.scheme === "file",
    );
    const keys = new Set(folders.map((f) => f.uri.toString()));
    for (const key of this.statuses.keys()) {
      if (keys.has(key)) continue;
      await this.stopProject(key, "workspace-removed");
      this.libraries.get(key)?.dispose();
      this.libraries.delete(key);
      this.statuses.delete(key);
      this.attempted.delete(key);
      this.recoveries.delete(key);
      this.pendingRecovery.delete(key);
    }
    for (const folder of folders) {
      if (this.disposed) break;
      const key = folder.uri.toString();
      const config = options(folder);
      const previous = this.attempted.get(key);
      const changed = !previous || !sameConfig(previous, config);
      const recovering = this.pendingRecovery.delete(key);
      const force = reasons.has("manual-restart") || recovering;
      const current = this.projects.get(key);
      if (current && !current.failed && !force && sameLanguageConfig(current.config, config)) {
        if (!sameConfig(current.config, config) && changed) {
          this.attempted.set(key, config);
          try {
            checkExecutableSetting(config.engine.executable, "dryas.apiPath");
            current.session.close();
            current.session = new ProjectSession(config);
            current.config = config;
            this.output.info(
              `Project ${folder.index + 1}: saved-validation settings updated; language-server connection retained.`,
            );
          } catch (error) {
            const details = startupError(error, "configuration");
            this.output.error(`Project ${folder.index + 1}: ${details.code}: ${details.message}`);
          }
        }
        this.attempted.set(key, config);
        continue;
      }
      if (!changed && !force) continue;
      if (changed || reasons.has("manual-restart")) this.recoveries.set(key, 0);
      const reason = [...reasons].join(", ");
      await this.stopProject(key, reason);
      this.attempted.set(key, config);
      await this.startProject(folder, config, reason);
    }
    this.updateStatusBar();
  }

  private async startProject(
    folder: vscode.WorkspaceFolder,
    config: ProjectConfig,
    reason: string,
  ): Promise<void> {
    const key = folder.uri.toString();
    const generation = (this.statuses.get(key)?.generation ?? 0) + 1;
    const base = { project: folder.index + 1, generation, reason, index: "unconfirmed" as const };
    let stage: StartupStage = "configuration";
    this.setStatus(key, {
      ...base,
      connection: "starting",
      stage,
      message: "Checking language-server configuration.",
    });
    this.output.info(
      `Project ${base.project}: starting language service (attempt ${generation}; reason: ${reason}).`,
    );
    let record: RunningProject | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkExecutableSetting(config.lspPath, "dryas.lspPath");
      stage = "model-folders";
      const snapshot = await readSnapshot(
        config.projectRoot,
        config.modelRoots ?? ["model"],
        undefined,
        true,
      );
      stage = "version-check";
      this.setStatus(key, {
        ...base,
        connection: "starting",
        stage,
        message: "Checking the language-server version.",
      });
      await verifyLanguageServer(config);
      if (this.disposed) return;
      const library = await this.libraryFor(key);
      const watchers = snapshot.roots.map((root) =>
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(root, "**/*.{sysml,kerml}"),
        ),
      );
      const modelFolder = {
        uri: vscode.Uri.file(snapshot.roots[0]!),
        name: folder.name,
        index: folder.index,
      };
      const client = new LanguageClient(
        `dryas-${folder.index}`,
        "DRYAS SysML",
        () =>
          new Promise<ChildProcess>((resolve, reject) => {
            const child = spawn(config.lspPath, ["-strict", "-no-record-cache"], {
              env: engineEnvironment(),
              windowsHide: true,
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
            });
            if (record) record.child = child;
            child.once("error", (error) => reject(startupError(error, "lsp-initialize")));
            child.once("spawn", () => resolve(child));
          }),
        {
          workspaceFolder: modelFolder,
          uriConverters: library.uriConverters,
          documentSelector: [
            ...snapshot.roots.flatMap((root) =>
              ["sysml", "kerml"].map((language) => ({
                scheme: "file",
                language,
                pattern: { baseUri: vscode.Uri.file(root).toString(), pattern: "**/*" },
              })),
            ),
            ...["sysml", "kerml"].map((language) => ({ scheme: library.scheme, language })),
          ],
          synchronize: { fileEvents: watchers },
          outputChannel: this.output,
          errorHandler: {
            error: () => {
              if (record) this.connectionLost(key, record, "ENGINE_PROTOCOL_ERROR");
              return { action: ErrorAction.Shutdown, handled: true };
            },
            closed: () => {
              if (record) this.connectionLost(key, record, "ENGINE_UNAVAILABLE");
              return { action: CloseAction.DoNotRestart, handled: true };
            },
          },
        },
      );
      record = { client, session: new ProjectSession(config), watchers, config, stopping: false };
      this.projects.set(key, record);
      stage = "lsp-initialize";
      this.setStatus(key, {
        ...base,
        connection: "starting",
        stage,
        message: "Connecting to the language server.",
      });
      await Promise.race([
        client.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AdapterError(
                  "TIMEOUT",
                  "The language-server initialization exceeded dryas.requestTimeoutMs.",
                ),
              ),
            config.engine.timeoutMs ?? 30000,
          );
        }),
      ]);
      if (record.failed) throw record.failed;
      if (this.disposed) {
        await this.stopProject(key, "extension-disposed");
        return;
      }
      if (!library.attach(client, config.engine.timeoutMs ?? 30000))
        this.output.info(
          `Project ${base.project}: the engine does not advertise standard-library browsing support.`,
        );
      if (snapshot.roots.length > 1)
        await client.sendNotification("workspace/didChangeWorkspaceFolders", {
          event: {
            added: snapshot.roots
              .slice(1)
              .map((root) => ({ uri: vscode.Uri.file(root).toString(), name: folder.name })),
            removed: [],
          },
        });
      if (record.failed) throw record.failed;
      this.setStatus(key, {
        ...base,
        connection: "connected",
        stage: "connected",
        message:
          "Language server connected. Initial indexing may still be running; the engine does not report index completion.",
      });
      this.output.info(
        `Project ${base.project}: LSP connected (attempt ${generation}). Index completion is unconfirmed; cross-file navigation may still be initializing.`,
      );
    } catch (error) {
      const details = record?.failed ?? startupError(error, stage);
      await this.stopProject(key, "startup-failed");
      this.setStatus(key, {
        ...base,
        connection: "error",
        stage,
        errorCode: details.code,
        message: details.message,
      });
      this.output.error(
        `Project ${base.project}: ${details.code} during ${stage}: ${details.message}`,
      );
      if (!this.disposed)
        void vscode.window
          .showWarningMessage(`DRYAS: ${details.message}`, "Settings", "Output")
          .then((action) => {
            if (action === "Settings")
              void vscode.commands.executeCommand(
                "workbench.action.openSettings",
                stage === "model-folders" ? "@id:dryas.modelRoots" : "dryas",
              );
            if (action === "Output") this.output.show();
          });
    } finally {
      clearTimeout(timer);
    }
  }

  private connectionLost(
    key: string,
    record: RunningProject,
    code: "ENGINE_UNAVAILABLE" | "ENGINE_PROTOCOL_ERROR",
  ): void {
    if (this.disposed || record.stopping || record.failed || this.projects.get(key) !== record)
      return;
    record.failed = new AdapterError(
      code,
      code === "ENGINE_PROTOCOL_ERROR"
        ? "The language-server connection reported a protocol error."
        : "The language-server connection closed unexpectedly.",
    );
    this.libraries.get(key)?.detach();
    const status = this.statuses.get(key);
    if (!status) return;
    const wasConnected = status.connection === "connected";
    this.setStatus(key, {
      ...status,
      connection: "error",
      stage: "transport",
      errorCode: code,
      message: record.failed.message,
    });
    this.output.error(`Project ${status.project}: ${code}: ${record.failed.message}`);
    if (wasConnected && (this.recoveries.get(key) ?? 0) < 1) {
      this.recoveries.set(key, 1);
      this.pendingRecovery.add(key);
      this.output.info(
        `Project ${status.project}: scheduling one automatic recovery after connection loss.`,
      );
      void this.refresh("engine-recovery");
    } else if (wasConnected) {
      this.output.error(
        `Project ${status.project}: automatic recovery limit reached. Use DRYAS: Restart Language Server to retry.`,
      );
    }
  }

  private async chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const current =
      vscode.window.activeTextEditor &&
      vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    if (current) return current;
    if (folders.length === 1) return folders[0];
    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, folder })),
      { placeHolder: "Select the project to validate" },
    );
    return selected?.folder;
  }

  private async validate(): Promise<void> {
    await this.refresh("validation");
    const folder = await this.chooseFolder();
    if (!folder) return;
    const running = this.projects.get(folder.uri.toString());
    if (!running || running.failed) {
      void vscode.window.showErrorMessage(
        "DRYAS is not connected. Check the model folders and engine settings.",
      );
      return;
    }
    try {
      checkExecutableSetting(options(folder).engine.executable, "dryas.apiPath");
    } catch (error) {
      void vscode.window.showErrorMessage(publicError(error).message);
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "DRYAS: Validating saved project",
        cancellable: true,
      },
      async (_, token) => {
        const controller = new AbortController();
        const listener = token.onCancellationRequested(() => controller.abort());
        try {
          const result = await running.session.validate({}, controller.signal);
          const document = await vscode.workspace.openTextDocument({
            language: "json",
            content: JSON.stringify(result, null, 2),
          });
          await vscode.window.showTextDocument(document, { preview: true });
        } catch (error) {
          void vscode.window.showErrorMessage(publicError(error).message);
        } finally {
          listener.dispose();
        }
      },
    );
  }

  private async showMcpConfiguration(): Promise<void> {
    const folder = await this.chooseFolder();
    if (!folder) return;
    const config = options(folder);
    const args = [
      join(this.context.extensionPath, "dist", "mcp.cjs"),
      "--project",
      folder.uri.fsPath,
      "--engine",
      config.engine.executable,
      "--expected-version",
      config.engine.expectedVersion!,
      "--timeout-ms",
      String(config.engine.timeoutMs),
    ];
    for (const root of config.modelRoots ?? ["model"]) args.push("--model-root", root);
    const document = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify({ mcpServers: { dryas: { command: "node", args } } }, null, 2),
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async stopProject(key: string, reason: string): Promise<void> {
    this.libraries.get(key)?.detach();
    const running = this.projects.get(key);
    if (!running) return;
    this.projects.delete(key);
    running.stopping = true;
    running.session.close();
    running.watchers.forEach((watcher) => watcher.dispose());
    const status = this.statuses.get(key);
    if (status) {
      this.setStatus(key, {
        ...status,
        connection: "stopped",
        stage: "stopped",
        reason,
        message: "Language server disconnected.",
      });
      this.output.info(`Project ${status.project}: stopping language service (reason: ${reason}).`);
    }
    await running.client.stop(1000).catch(() => undefined);
    if (running.child?.exitCode === null && running.child.signalCode === null) running.child.kill();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.refreshQueue.dispose();
    await Promise.all(
      [...this.projects.keys()].map((key) => this.stopProject(key, "extension-disposed")),
    );
    this.libraries.forEach((library) => library.dispose());
    this.libraries.clear();
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<{ getLanguageServiceStatus: () => ServiceStatus[] }> {
  manager = new Manager(context);
  await manager.refresh("activation");
  const current = manager;
  return { getLanguageServiceStatus: () => current.getStatus() };
}
export async function deactivate(): Promise<void> {
  await manager?.dispose();
  manager = undefined;
}
