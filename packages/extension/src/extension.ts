// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { observeEditorDiagnostics } from "./editor-diagnostics.js";
import { Projects, overlappingRoots } from "./projects.js";
import {
  LanguageClient,
  CloseAction,
  ErrorAction,
  DocumentSymbolRequest,
} from "vscode-languageclient/node";
import {
  ProjectSession,
  readSnapshot,
  readProjectSnapshot,
  readProjectDefinition,
  writeProjectDefinition,
  resolveProjectGraph,
  PROJECT_FILE,
  publicError,
  DEFAULT_LANGUAGE_ENGINE_PROVIDER,
  assertLanguageEngineProvider,
  createLanguageBackend,
  type LanguageEngineProvider,
  AdapterError,
  type ProjectOptions,
} from "@dryas/engine-adapter";
import { RefreshQueue, type RefreshReason } from "./refresh.js";
import { StdlibDocuments } from "./stdlib.js";
import { NamespaceDrafts } from "./namespace-drafts.js";
import { ReferenceDocuments } from "./reference-documents.js";
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
  drafts: NamespaceDrafts;
  references?: ReferenceDocuments;
  session: ProjectSession;
  watchers: vscode.FileSystemWatcher[];
  config: ProjectConfig;
  child?: ChildProcess;
  stopping: boolean;
  failed?: AdapterError;
}

interface ServiceStatus {
  project: number;
  name?: string;
  connection: "starting" | "connected" | "stopped" | "error";
  index: "unconfirmed";
  stage: string;
  reason: string;
  generation: number;
  errorCode?: string;
  message: string;
}
let manager: Manager | undefined;

function options(
  folder: vscode.WorkspaceFolder,
  provider: LanguageEngineProvider,
): ProjectOptions & { lspPath: string } {
  const settings = vscode.workspace.getConfiguration("dryas", folder.uri);
  return {
    projectRoot: folder.uri.fsPath,
    modelRoots: settings.get<string[]>("modelRoots", ["."]),
    lspPath:
      settings.get<string>("lspPath", "sysml-lsp") === "sysml-lsp"
        ? (process.env.DRYAS_LSP_PATH ?? "sysml-lsp")
        : settings.get<string>("lspPath")!,
    engine: {
      executable:
        settings.get<string>("apiPath", "sysml-grpc") === "sysml-grpc"
          ? (process.env.DRYAS_API_PATH ?? "sysml-grpc")
          : settings.get<string>("apiPath")!,
      expectedVersion: settings.get<string>("expectedEngineVersion", provider.defaultEngineVersion),
      timeoutMs: settings.get<number>("requestTimeoutMs", 30000),
    },
  };
}

export class Manager {
  private readonly projects = new Map<string, RunningProject>();
  private readonly libraries = new Map<string, StdlibDocuments>();
  private readonly attempted = new Map<string, ProjectConfig>();
  private readonly configurationWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly statuses = new Map<string, ServiceStatus>();
  private readonly recoveries = new Map<string, number>();
  private readonly pendingRecovery = new Set<string>();
  private readonly pendingDependencyReload = new Set<string>();
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
  private readonly projectUi: Projects;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly provider: LanguageEngineProvider = DEFAULT_LANGUAGE_ENGINE_PROVIDER,
  ) {
    assertLanguageEngineProvider(provider);
    this.projectUi = new Projects(
      context,
      (folder) => this.statuses.get(folder.uri.toString()),
      () => this.updateStatusBar(),
      {
        symbols: (folder, uri) => this.documentSymbols(folder, uri),
        presentation: (detail) => this.provider.languageService.outlinePresentation?.(detail),
        libraries: async (folder) => {
          this.runningProject(folder);
          const library = this.libraries.get(folder.uri.toString());
          if (!library)
            throw new AdapterError(
              "QUERY_UNAVAILABLE",
              "Library browsing is not ready. Refresh after the language service connects.",
            );
          try {
            return await library.namespaces(
              vscode.Uri.file(
                join(context.globalStorageUri.fsPath, `library-query-${randomUUID()}.sysml`),
              ).toString(),
            );
          } catch {
            throw new AdapterError(
              "QUERY_UNAVAILABLE",
              "The language service could not list library namespaces. Refresh to retry.",
            );
          }
        },
        refreshLibraries: () => this.libraries.forEach((library) => library.clearCatalog()),
        referenceUri: (folder, uri) => {
          const references = this.runningProject(folder).references;
          if (!references)
            throw new AdapterError(
              "QUERY_UNAVAILABLE",
              "Project references are not connected. Refresh after the language service connects.",
            );
          return references.fromSource(uri);
        },
      },
      async (folder, name) => {
        const running = this.runningProject(folder);
        const source = await running.drafts.prepare(
          running.client,
          name,
          () =>
            vscode.Uri.file(
              join(context.globalStorageUri.fsPath, `namespace-check-${randomUUID()}.sysml`),
            ).toString(),
          running.config.engine.timeoutMs ?? 30000,
        );
        if (this.runningProject(folder) !== running)
          throw new AdapterError(
            "PROJECT_CHANGED",
            "The language service changed while checking this name. Create the namespace again.",
          );
        return source;
      },
      () => this.refresh("configuration"),
    );
    if (typeof vscode.lm?.registerTool === "function")
      context.subscriptions.push(
        vscode.lm.registerTool("dryas_editor_diagnostics", {
          invoke: () =>
            new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(this.observeEditorDiagnostics())),
            ]),
        }),
      );
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
      vscode.commands.registerCommand("dryas.validateProject", (folder?: vscode.WorkspaceFolder) =>
        this.validate(folder),
      ),
      vscode.commands.registerCommand(
        "dryas.configureModelRoots",
        (folder?: vscode.WorkspaceFolder) => this.configureModelRoots(folder),
      ),
    );
  }

  refresh(reason: RefreshReason, delay = 0): Promise<void> {
    return this.refreshQueue.request(reason, delay);
  }

  getProjectTree(): Projects {
    return this.projectUi;
  }

  observeEditorDiagnostics() {
    return observeEditorDiagnostics(
      this.getStatus(),
      new Set([...this.libraries.values()].map((library) => library.scheme)),
    );
  }

  private runningProject(folder: vscode.WorkspaceFolder): RunningProject {
    const running = this.projects.get(folder.uri.toString());
    if (
      !running ||
      running.failed ||
      this.statuses.get(folder.uri.toString())?.connection !== "connected"
    )
      throw new AdapterError(
        "QUERY_UNAVAILABLE",
        "The language service is not ready. Refresh after it connects.",
      );
    return running;
  }

  private async documentSymbols(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[]> {
    const running = this.runningProject(folder);
    const document = await vscode.workspace.openTextDocument(uri);
    const provider = running.client.getFeature(DocumentSymbolRequest.method).getProvider(document);
    if (!provider)
      throw new AdapterError(
        "UNSUPPORTED_CAPABILITY",
        "This language service cannot browse document declarations.",
      );
    const cancellation = new vscode.CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const symbols = await Promise.race([
        provider.provideDocumentSymbols(document, cancellation.token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancellation.cancel();
            reject(
              new AdapterError("TIMEOUT", "Loading declarations exceeded the request deadline."),
            );
          }, running.config.engine.timeoutMs ?? 30000);
        }),
      ]);
      if (this.projects.get(folder.uri.toString()) !== running)
        throw new AdapterError(
          "QUERY_UNAVAILABLE",
          "The language service changed. Refresh the project tree.",
        );
      return symbols ?? [];
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
    }
  }

  getStatus(): ServiceStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }));
  }

  private async libraryFor(key: string): Promise<StdlibDocuments> {
    const existing = this.libraries.get(key);
    if (existing) return existing;
    // Persist an opaque identity in editor workspace storage so restored tabs
    // retain their owning project without exposing its filesystem path in URIs.
    const stateKey = `${this.provider.languageService.standardLibrary.storageKeyPrefix}.${key}`;
    const saved = this.context.workspaceState.get<string>(stateKey);
    const scheme =
      saved && /^dryas-stdlib-[a-f0-9-]{36}$/.test(saved) ? saved : `dryas-stdlib-${randomUUID()}`;
    if (scheme !== saved) await this.context.workspaceState.update(stateKey, scheme);
    const library = new StdlibDocuments(scheme, this.provider.languageService.standardLibrary);
    this.libraries.set(key, library);
    return library;
  }

  private setStatus(key: string, status: ServiceStatus): void {
    this.statuses.set(key, status);
    this.projectUi.refresh();
  }

  private updateStatusBar(): void {
    if (this.disposed) return;
    const folder = this.projectUi.current;
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
    this.statusBar.text = `${label}${folder ? ` · ${folder.name}` : ""}`;
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

  private watchProjectConfiguration(root: string): void {
    if (this.configurationWatchers.has(root)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, PROJECT_FILE),
    );
    const changed = () => {
      this.projectUi.refresh();
      void this.refresh("configuration", 150);
    };
    watcher.onDidCreate(changed);
    watcher.onDidChange(changed);
    watcher.onDidDelete(changed);
    this.configurationWatchers.set(root, watcher);
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
      this.pendingDependencyReload.delete(key);
    }
    const canonicalRoots = new Map(
      await Promise.all(
        folders.map(
          async (folder) =>
            [
              folder.uri.toString(),
              await realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath),
            ] as const,
        ),
      ),
    );
    const watched = new Set<string>();
    for (const folder of folders) {
      if (this.disposed) break;
      const key = folder.uri.toString();
      const config: ProjectConfig = options(folder, this.provider);
      try {
        config.graph = await resolveProjectGraph(
          config.projectRoot,
          config.modelRoots,
          undefined,
          (root) => {
            watched.add(root);
            this.watchProjectConfiguration(root);
          },
        );
        config.modelRoots = config.graph.projects[0]!.definition.modelRoots;
      } catch (error) {
        await this.stopProject(key, "project-references");
        this.attempted.delete(key);
        const details = startupError(error, "model-folders");
        this.setStatus(key, {
          project: folder.index + 1,
          name: folder.name,
          generation: this.statuses.get(key)?.generation ?? 0,
          reason: "configuration",
          index: "unconfirmed",
          connection: "error",
          stage: "project-references",
          errorCode: details.code,
          message: details.message,
        });
        continue;
      }
      if (
        folders.some(
          (other) =>
            other !== folder &&
            overlappingRoots(canonicalRoots.get(key)!, canonicalRoots.get(other.uri.toString())!),
        )
      ) {
        await this.stopProject(key, "project-roots-overlap");
        this.attempted.delete(key);
        this.setStatus(key, {
          project: folder.index + 1,
          name: folder.name,
          generation: this.statuses.get(key)?.generation ?? 0,
          reason: "workspace",
          index: "unconfirmed",
          connection: "error",
          stage: "project-root",
          errorCode: "INVALID_PATH",
          message:
            "Project roots overlap. Use separate root folders so model sessions remain isolated.",
        });
        continue;
      }
      const previous = this.attempted.get(key);
      const changed = !previous || !sameConfig(previous, config);
      const recovering = this.pendingRecovery.delete(key);
      const dependencyReload = this.pendingDependencyReload.delete(key);
      const force = reasons.has("manual-restart") || recovering || dependencyReload;
      const current = this.projects.get(key);
      if (current && !current.failed && !force && sameLanguageConfig(current.config, config)) {
        if (!sameConfig(current.config, config) && changed) {
          this.attempted.set(key, config);
          try {
            checkExecutableSetting(config.engine.executable, "dryas.apiPath");
            const replacement = new ProjectSession(
              config,
              createLanguageBackend(this.provider, config.engine),
            );
            current.session.close();
            current.session = replacement;
            current.config = config;
            this.output.info(
              `Project ${folder.index + 1}: saved-validation settings updated; language-server connection retained.`,
            );
          } catch (error) {
            const details = startupError(error, "configuration");
            const message =
              "Saved-validation settings could not be applied. The language server remains connected and the previous saved-validation settings are still in use.";
            const status = this.statuses.get(key);
            if (status)
              this.setStatus(key, {
                ...status,
                stage: "saved-validation-configuration",
                errorCode: details.code,
                message,
              });
            this.output.error(
              `Project ${folder.index + 1}: ${details.code}: ${details.message} ${message}`,
            );
          }
        }
        // A successful replacement or a return to the last working settings
        // clears the saved-validation warning without restarting the LSP.
        const status = this.statuses.get(key);
        if (
          sameConfig(current.config, config) &&
          status?.stage === "saved-validation-configuration"
        ) {
          const updated = { ...status };
          delete updated.errorCode;
          this.setStatus(key, {
            ...updated,
            stage: "connected",
            message:
              "Language server connected. Initial indexing may still be running; the engine does not report index completion.",
          });
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
    for (const [root, watcher] of this.configurationWatchers)
      if (!watched.has(root)) {
        watcher.dispose();
        this.configurationWatchers.delete(root);
      }
    this.projectUi.refresh();
  }

  private async startProject(
    folder: vscode.WorkspaceFolder,
    config: ProjectConfig,
    reason: string,
  ): Promise<void> {
    const key = folder.uri.toString();
    const generation = (this.statuses.get(key)?.generation ?? 0) + 1;
    const base = {
      project: folder.index + 1,
      name: folder.name,
      generation,
      reason,
      index: "unconfirmed" as const,
    };
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
    let session: ProjectSession | undefined;
    let client: LanguageClient | undefined;
    const drafts = new NamespaceDrafts();
    let references: ReferenceDocuments | undefined;
    const watchers: vscode.FileSystemWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkExecutableSetting(config.lspPath, "dryas.lspPath");
      stage = "model-folders";
      const snapshot = await readProjectSnapshot(
        config.projectRoot,
        config.modelRoots ?? ["."],
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
      await verifyLanguageServer(config, this.provider.languageService);
      if (this.disposed) return;
      const library = await this.libraryFor(key);
      const graph =
        config.graph ?? (await resolveProjectGraph(config.projectRoot, config.modelRoots));
      if (graph.key !== snapshot.scopeKey)
        throw new AdapterError(
          "PROJECT_CHANGED",
          "Project references changed while opening the language service. Refresh the project.",
        );
      if (graph.projects.length > 1) references = new ReferenceDocuments(graph);
      const referenceDocuments = references;
      stage = "configuration";
      session = new ProjectSession(config, createLanguageBackend(this.provider, config.engine));
      stage = "lsp-initialize";
      for (const root of snapshot.roots) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(root, "**/*.{sysml,kerml}"),
        );
        if (referenceDocuments) watcher.onDidChange((uri) => referenceDocuments.refresh(uri));
        watcher.onDidCreate((uri) => {
          referenceDocuments?.refresh(uri);
          this.projectUi.refresh();
        });
        watcher.onDidDelete((uri) => {
          // An opened dependency can remain in the server's document cache after
          // deletion. Reload only its consumers, coalescing a burst of deletions.
          if (
            referenceDocuments &&
            referenceDocuments.fromSource(uri).scheme === referenceDocuments.scheme &&
            record &&
            !record.stopping &&
            this.projects.get(key) === record
          ) {
            this.pendingDependencyReload.add(key);
            void this.refresh("dependency-deleted", 150);
          }
          this.projectUi.refresh();
        });
        watchers.push(watcher);
      }
      const modelFolder = {
        uri: vscode.Uri.file(snapshot.roots[0]!),
        name: folder.name,
        index: folder.index,
      };
      client = new LanguageClient(
        `dryas-${library.scheme}`,
        "DRYAS SysML",
        () =>
          new Promise<ChildProcess>((resolve, reject) => {
            const child = spawn(config.lspPath, [...this.provider.languageService.launch.args], {
              env: this.provider.languageService.launch.environment(),
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
          uriConverters: {
            protocol2Code: (value) => {
              const uri = library.uriConverters.protocol2Code(value);
              return referenceDocuments?.fromSource(uri) ?? uri;
            },
            code2Protocol: (uri) =>
              library.uriConverters.code2Protocol(referenceDocuments?.toSource(uri) ?? uri),
          },
          middleware: {
            handleDiagnostics: (uri, diagnostics, next) => {
              if (
                drafts.acceptDiagnostics(
                  uri.toString(),
                  diagnostics.some(
                    (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error,
                  ),
                )
              )
                return;
              if (!library.isInternalUri(uri)) next(uri, diagnostics);
            },
          },
          documentSelector: [
            ...graph.projects[0]!.roots.flatMap((root) =>
              ["sysml", "kerml"].map((language) => ({
                scheme: "file",
                language,
                pattern: { baseUri: vscode.Uri.file(root).toString(), pattern: "**/*" },
              })),
            ),
            ...["sysml", "kerml"].map((language) => ({ scheme: library.scheme, language })),
            ...(referenceDocuments
              ? ["sysml", "kerml"].map((language) => ({
                  scheme: referenceDocuments.scheme,
                  language,
                }))
              : []),
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
      record = {
        client,
        drafts,
        ...(references ? { references } : {}),
        session,
        watchers,
        config,
        stopping: false,
      };
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
      if (record) {
        await this.stopProject(key, "startup-failed");
      } else {
        // A factory or constructor can fail before a project record exists.
        // Retire every successfully allocated resource in that partial startup.
        drafts.dispose();
        await references?.close();
        session?.close();
        watchers.forEach((watcher) => watcher.dispose());
        await client?.stop(1000).catch(() => undefined);
        this.libraries.get(key)?.detach();
      }
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
    record.drafts.dispose();
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

  private async chooseFolder(
    requested?: vscode.WorkspaceFolder,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const folder = this.projectUi.resolve(requested);
    if (!folder)
      void vscode.window.showInformationMessage(
        "Open a Systrace project from the Projects view first.",
      );
    return folder;
  }

  private async validate(requested?: vscode.WorkspaceFolder): Promise<void> {
    const folder = await this.chooseFolder(requested);
    if (!folder) return;
    await this.refresh("validation");
    const running = this.projects.get(folder.uri.toString());
    if (!running || running.failed) {
      void vscode.window.showErrorMessage(
        "DRYAS is not connected. Check the model folders and engine settings.",
      );
      return;
    }
    try {
      checkExecutableSetting(options(folder, this.provider).engine.executable, "dryas.apiPath");
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

  private async configureModelRoots(requested?: vscode.WorkspaceFolder): Promise<void> {
    const folder = await this.chooseFolder(requested);
    if (!folder) return;
    const selected = await vscode.window.showOpenDialog({
      title: `Model source folders for ${folder.name}`,
      defaultUri: folder.uri,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "Use Source Folders",
    });
    if (!selected?.length || selected.some((uri) => uri.scheme !== "file")) return;
    const roots = selected.map(
      (uri) => relative(folder.uri.fsPath, uri.fsPath).split(sep).join("/") || ".",
    );
    try {
      await readSnapshot(folder.uri.fsPath, roots, undefined, true);
      if (!this.projectUi.resolve(folder)) return;
      const definition = await readProjectDefinition(
        folder.uri.fsPath,
        options(folder, this.provider).modelRoots,
      );
      await writeProjectDefinition(folder.uri.fsPath, { ...definition, modelRoots: roots });
      this.projectUi.refresh();
      await this.refresh("configuration");
    } catch (error) {
      void vscode.window.showErrorMessage(publicError(error).message);
    }
  }

  private async stopProject(key: string, reason: string): Promise<void> {
    this.libraries.get(key)?.detach();
    const running = this.projects.get(key);
    if (!running) return;
    this.projects.delete(key);
    running.stopping = true;
    running.drafts.dispose();
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
    await running.references?.close();
    if (running.child?.exitCode === null && running.child.signalCode === null) running.child.kill();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.projectUi.dispose();
    await this.refreshQueue.dispose();
    await Promise.all(
      [...this.projects.keys()].map((key) => this.stopProject(key, "extension-disposed")),
    );
    this.libraries.forEach((library) => library.dispose());
    this.libraries.clear();
    this.configurationWatchers.forEach((watcher) => watcher.dispose());
    this.configurationWatchers.clear();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<{
  getLanguageServiceStatus: () => ServiceStatus[];
  getProjectTree: () => Projects;
  getEditorDiagnostics: () => ReturnType<typeof observeEditorDiagnostics>;
}> {
  manager = new Manager(context);
  await manager.refresh("activation");
  const current = manager;
  return {
    getLanguageServiceStatus: () => current.getStatus(),
    getProjectTree: () => current.getProjectTree(),
    getEditorDiagnostics: () => current.observeEditorDiagnostics(),
  };
}
export async function deactivate(): Promise<void> {
  await manager?.dispose();
  manager = undefined;
}
