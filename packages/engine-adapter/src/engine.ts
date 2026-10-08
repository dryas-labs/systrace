// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { z } from "zod";
import { AdapterError } from "./errors.js";

export const ENGINE_VERSION = "v0.9.2-dryas.4";
export const serverInfoSchema = z.object({
  version: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;
export interface EngineOptions {
  executable: string;
  expectedVersion?: string;
  timeoutMs?: number;
  args?: string[];
}

export function engineEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DRYAS_LLM_") || key.startsWith("OPENSYSML_")) delete env[key];
  }
  return env;
}

export class EngineConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: MessageConnection | undefined;
  private starting: Promise<ServerInfo> | undefined;
  private info: ServerInfo | undefined;
  private closed = false;
  private failures = 0;
  private pendingFailure: ((error: AdapterError) => void) | undefined;
  private epoch = 0;

  get generation(): number {
    return this.epoch;
  }

  get connected(): boolean {
    return this.info !== undefined;
  }

  constructor(private readonly options: EngineOptions) {}

  async start(signal?: AbortSignal): Promise<ServerInfo> {
    if (signal?.aborted) throw new AdapterError("CANCELLED", "The request was cancelled.");
    if (this.closed || this.failures > 1)
      throw new AdapterError(
        "ENGINE_UNAVAILABLE",
        "Restart the project session to reconnect the engine.",
      );
    if (this.info) return this.info;
    if (this.starting) return this.starting;
    this.starting = this.connect(signal);
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async connect(signal?: AbortSignal): Promise<ServerInfo> {
    this.epoch += 1;
    this.child = spawn(
      this.options.executable,
      this.options.args ?? ["-transport", "stdio", "-log-level", "error"],
      {
        shell: false,
        windowsHide: true,
        env: engineEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const child = this.child;
    child.stderr.resume();
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection = connection;
    const fail = () => {
      if (this.child === child)
        this.retire(
          new AdapterError("ENGINE_UNAVAILABLE", "The engine process stopped unexpectedly."),
        );
    };
    child.on("error", fail);
    child.on("exit", fail);
    connection.onError(() => {
      if (this.connection === connection)
        this.retire(
          new AdapterError(
            "ENGINE_PROTOCOL_ERROR",
            "The engine returned an invalid protocol message.",
          ),
        );
    });
    connection.onClose(fail);
    connection.listen();
    const parsed = serverInfoSchema.safeParse(await this.send("GetServerInfo", {}, signal));
    if (!parsed.success) {
      this.retire();
      throw new AdapterError("ENGINE_PROTOCOL_ERROR", "The engine handshake was malformed.");
    }
    if (parsed.data.version !== (this.options.expectedVersion ?? ENGINE_VERSION)) {
      this.retire();
      throw new AdapterError(
        "ENGINE_VERSION_MISMATCH",
        "The engine version does not match the configured development version.",
      );
    }
    this.info = parsed.data;
    return parsed.data;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return this.send(method, params, signal);
  }

  private async send(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new AdapterError("CANCELLED", "The request was cancelled.");
    const connection = this.connection;
    if (!connection) throw new AdapterError("ENGINE_UNAVAILABLE", "The engine is not connected.");
    if (this.pendingFailure)
      throw new AdapterError(
        "QUEUE_FULL",
        "Engine requests must be serialized by the project session.",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const failed = new Promise<never>((_, reject) => {
      this.pendingFailure = reject;
      timer = setTimeout(
        () => this.retire(new AdapterError("TIMEOUT", "The engine request exceeded its deadline.")),
        this.options.timeoutMs ?? 30000,
      );
      cancel = () => this.retire(new AdapterError("CANCELLED", "The request was cancelled."));
      signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([connection.sendRequest(method, params), failed]);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      // Native stdio uses canonical gRPC status codes. A rejected query is not
      // a broken transport; keep the session usable and omit raw exception text.
      if (error instanceof ResponseError) {
        if (error.code === 12 || error.code === -32601)
          throw new AdapterError(
            "UNSUPPORTED_CAPABILITY",
            "The engine cannot execute this query operation.",
          );
        if (error.code === 3 || error.code === -32602)
          throw new AdapterError(
            "INVALID_ARGUMENT",
            "The engine rejected the query arguments or scope.",
          );
        if (error.code === 5)
          throw new AdapterError(
            "ELEMENT_NOT_FOUND",
            "The engine could not find the requested model or element.",
          );
        if (error.code === 9)
          throw new AdapterError(
            "QUERY_UNAVAILABLE",
            "The engine cannot provide an unambiguous, stable answer for this element.",
          );
      }
      this.retire();
      throw new AdapterError(
        "ENGINE_PROTOCOL_ERROR",
        "The engine request failed; no result is available.",
      );
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener("abort", cancel);
      this.pendingFailure = undefined;
    }
  }

  private retire(error?: AdapterError): void {
    const child = this.child;
    const connection = this.connection;
    this.child = undefined;
    this.connection = undefined;
    this.info = undefined;
    if (child) this.failures += 1;
    this.pendingFailure?.(
      error ?? new AdapterError("ENGINE_UNAVAILABLE", "The engine connection ended."),
    );
    connection?.dispose();
    child?.stdin.end();
    child?.kill();
    if (child && child.exitCode === null) {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }

  close(): void {
    this.closed = true;
    this.retire();
  }
}
