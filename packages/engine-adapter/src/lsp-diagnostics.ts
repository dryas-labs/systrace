// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { z } from "zod";
import { AdapterError } from "./errors.js";
import { DEFAULT_LANGUAGE_ENGINE_PROVIDER } from "./default-engine.js";
import type { LanguageEngineProvider } from "./provider.js";
import {
  resolveDiagnosticsProject,
  type DiagnosticsProjectOptions,
} from "./diagnostics-project.js";
import { readSnapshot, relativeName } from "./snapshot.js";
import { verifyLanguageServiceVersion } from "./lsp-version.js";

const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const publication = z.object({
  uri: z.string(),
  version: z.number().int().optional(),
  diagnostics: z.array(
    z.object({
      range: z.object({ start: position, end: position }),
      message: z.string(),
      severity: z.number().int().min(1).max(4).optional(),
      code: z.union([z.string(), z.number()]).optional(),
      source: z.string().optional(),
      tags: z.array(z.number().int()).optional(),
      relatedInformation: z
        .array(
          z.object({
            message: z.string(),
            location: z.object({
              uri: z.string(),
              range: z.object({ start: position, end: position }),
            }),
          }),
        )
        .optional(),
    }),
  ),
});
export interface LspDiagnosticsOptions extends DiagnosticsProjectOptions {
  lspPath?: string;
  expectedVersion?: string;
  paths?: string[];
  overlay?: { path: string; text: string };
  timeoutMs?: number;
}
export interface ObservedDiagnostic {
  file: string;
  library: boolean;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  severity: "error" | "warning" | "information" | "hint" | "unspecified";
  message: string;
  code?: string | number;
  source?: string;
  tags?: number[];
  relatedInformation?: {
    message: string;
    location: { uri: string; range: ObservedDiagnostic["range"] };
  }[];
}

function uriKey(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  const path = fileURLToPath(uri);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export async function observeLspDiagnostics(
  options: LspDiagnosticsOptions,
  provider: LanguageEngineProvider = DEFAULT_LANGUAGE_ENGINE_PROVIDER,
) {
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000)
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "The timeout must be between 1 and 300000 milliseconds.",
    );
  const deadline = Date.now() + timeout;
  const { graph, context } = await resolveDiagnosticsProject(options);
  const root = context.project.root;
  const documents: { uri: string; file: string; language: string; content: string }[] = [];
  for (const [index, project] of graph.projects.entries()) {
    const snapshot = await readSnapshot(
      project.root,
      project.definition.modelRoots,
      undefined,
      true,
    );
    for (const doc of snapshot.documents)
      documents.push({
        uri: pathToFileURL(join(project.root, doc.name)).toString(),
        file: index === 0 ? doc.name : `.references/${project.id}/${doc.name}`,
        language: doc.language,
        content: doc.content,
      });
  }
  if (
    documents.length > 2000 ||
    documents.reduce((sum, doc) => sum + Buffer.byteLength(doc.content), 0) > 32 * 1024 * 1024
  )
    throw new AdapterError(
      "LIMIT_EXCEEDED",
      "The saved project and references exceed the model input limit.",
    );
  if (options.overlay) {
    const name = relativeName(options.overlay.path);
    const doc = documents.find(
      (entry) => entry.file === name && !entry.file.startsWith(".references/"),
    );
    if (!doc)
      throw new AdapterError(
        "INVALID_PATH",
        "Overlay must replace an existing file in the project's configured model scope.",
      );
    if (Buffer.byteLength(options.overlay.text) > 2 * 1024 * 1024)
      throw new AdapterError("LIMIT_EXCEEDED", "Overlay text exceeds the file size limit.");
    doc.content = options.overlay.text;
  }
  const paths = (options.paths ?? []).map(relativeName);
  const visible = (file: string) =>
    !paths.length ||
    paths.some((path) => path === "." || path === file || file.startsWith(path + "/"));
  const expected = options.expectedVersion ?? provider.defaultEngineVersion;
  const backend = provider.languageService;
  const executable = options.lspPath ?? "sysml-lsp";
  const remaining = () => Math.max(1, deadline - Date.now());
  if (Date.now() >= deadline)
    throw new AdapterError(
      "TIMEOUT",
      "The command deadline elapsed before language-server initialization.",
    );
  try {
    await verifyLanguageServiceVersion(executable, expected, backend, remaining());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT")
      throw new AdapterError(
        "ENGINE_NOT_FOUND",
        "Supply --lsp <executable> or make sysml-lsp available on PATH.",
      );
    if (code === "EACCES" || code === "EPERM")
      throw new AdapterError(
        "ENGINE_ACCESS_DENIED",
        "Check access to the configured language-server executable.",
      );
    throw error;
  }
  const child = spawn(executable, [...backend.launch.args], {
    shell: false,
    windowsHide: true,
    env: backend.launch.environment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  const opened = new Set<string>();
  const received = new Set<string>();
  const byUri = new Map(documents.map((doc) => [uriKey(doc.uri), doc]));
  const reports = new Map<string, ObservedDiagnostic[]>();
  let ready = false,
    sentAll = false,
    closing = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let alarm: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void;
  const quietResult = new Promise<boolean>((resolve) => {
    settle = () => resolve(true);
  });
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const unavailable = () => {
    if (!closing)
      fail(
        new AdapterError(
          "ENGINE_UNAVAILABLE",
          "The language server stopped before the diagnostic observation finished.",
        ),
      );
  };
  child.on("error", unavailable);
  child.on("exit", unavailable);
  connection.onClose(unavailable);
  connection.onError(() => {
    if (!closing)
      fail(
        new AdapterError(
          "ENGINE_PROTOCOL_ERROR",
          "The language server returned an invalid protocol stream.",
        ),
      );
  });
  const checkQuiet = () => {
    clearTimeout(quiet);
    if (sentAll && documents.length > 0 && received.size === documents.length)
      quiet = setTimeout(settle, 500);
  };
  connection.onNotification("textDocument/publishDiagnostics", (value: unknown) => {
    if (closing) return;
    const parsed = publication.safeParse(value);
    if (!parsed.success) {
      fail(
        new AdapterError(
          "ENGINE_PROTOCOL_ERROR",
          "The language server returned invalid diagnostics.",
        ),
      );
      return;
    }
    const { uri, diagnostics, version } = parsed.data;
    checkQuiet();
    let key: string;
    try {
      key = uriKey(uri);
    } catch {
      fail(new AdapterError("ENGINE_PROTOCOL_ERROR", "A diagnostic document URI is invalid."));
      return;
    }
    const doc = byUri.get(key);
    const library = uri.startsWith(backend.standardLibrary.scheme + ":");
    if (!doc && !library) return;
    // Version is optional in push diagnostics. Reject explicit stale versions.
    if (doc && version !== undefined && version !== 1) return;
    if (doc && opened.has(key)) received.add(key);
    reports.set(
      key,
      diagnostics.map((diagnostic) => ({
        file: doc?.file ?? uri,
        library,
        range: {
          start: {
            line: diagnostic.range.start.line + 1,
            column: diagnostic.range.start.character + 1,
          },
          end: { line: diagnostic.range.end.line + 1, column: diagnostic.range.end.character + 1 },
        },
        severity: (["unspecified", "error", "warning", "information", "hint"] as const)[
          diagnostic.severity ?? 0
        ]!,
        message: diagnostic.message,
        ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
        ...(diagnostic.tags === undefined ? {} : { tags: diagnostic.tags }),
        ...(diagnostic.relatedInformation === undefined
          ? {}
          : {
              relatedInformation: diagnostic.relatedInformation.map((information) => ({
                message: information.message,
                location: {
                  uri: information.location.uri,
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
            }),
      })),
    );
    checkQuiet();
  });
  connection.onRequest("workspace/configuration", (params: { items?: unknown[] }) =>
    (params.items ?? []).map(() => ({})),
  );
  connection.onRequest("client/registerCapability", () => null);
  connection.onRequest("window/workDoneProgress/create", () => null);
  const folders = graph.projects.flatMap((project) =>
    project.roots.map((path) => ({ uri: pathToFileURL(path).toString(), name: project.name })),
  );
  connection.onRequest("workspace/workspaceFolders", () => folders);
  connection.listen();
  try {
    const limit = new Promise<boolean>((resolve, reject) => {
      alarm = setTimeout(
        () =>
          ready
            ? resolve(false)
            : reject(
                new AdapterError("TIMEOUT", "The language-server handshake exceeded the deadline."),
              ),
        remaining(),
      );
    });
    const work = (async () => {
      const initialized = await connection.sendRequest<{
        capabilities: { positionEncoding?: string };
      }>("initialize", {
        processId: process.pid,
        rootUri: folders[0]?.uri ?? pathToFileURL(root).toString(),
        workspaceFolders: folders,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            publishDiagnostics: {
              versionSupport: true,
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
        },
      });
      if (
        !initialized?.capabilities ||
        (initialized.capabilities.positionEncoding &&
          initialized.capabilities.positionEncoding !== "utf-16")
      )
        throw new AdapterError(
          "ENGINE_PROTOCOL_ERROR",
          "The language server did not negotiate UTF-16 positions.",
        );
      await connection.sendNotification("initialized", {});
      ready = true;
      for (const doc of documents) {
        if (closing) return false;
        opened.add(uriKey(doc.uri));
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: { uri: doc.uri, languageId: doc.language, version: 1, text: doc.content },
        });
      }
      sentAll = true;
      if (!documents.length) return false;
      checkQuiet();
      return quietResult;
    })();
    const settled = await Promise.race([work, limit, failed]);
    return {
      observation: "lsp-recompute" as const,
      settled,
      index: "unconfirmed" as const,
      positionEncoding: "utf-16" as const,
      positionBase: 1 as const,
      engine: { name: provider.id, version: expected },
      files: documents.map((doc) => ({ file: doc.file, received: received.has(uriKey(doc.uri)) })),
      project: context.project,
      references: context.references,
      paths,
      ...(options.overlay ? { overlay: relativeName(options.overlay.path) } : {}),
      diagnostics: [...reports.values()].flat().filter((diagnostic) => visible(diagnostic.file)),
    };
  } finally {
    closing = true;
    clearTimeout(quiet);
    clearTimeout(alarm);
    if (ready && child.exitCode === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        connection
          .sendRequest("shutdown")
          .then(() => connection.sendNotification("exit"))
          .catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 300);
        }),
      ]);
      clearTimeout(timer);
    }
    connection.dispose();
    if (child.exitCode === null) child.kill();
  }
}
