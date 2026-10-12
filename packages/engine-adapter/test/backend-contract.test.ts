// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../mcp-server/src/server.js";
import { OpenSysMLBackend } from "../src/backends/opensysml/backend.js";
import { createLanguageBackend, type LanguageEngineProvider } from "../src/provider.js";
import { ProjectSession } from "../src/project.js";
import { AdapterError } from "../src/errors.js";
import {
  LANGUAGE_ENGINE_INTERFACE_VERSION,
  type BackendCapability,
  type BackendDiagnostic,
  type BackendInfo,
  type BackendValidation,
  type LanguageBackend,
  type ModelHandle,
  type ValidationEvidence,
} from "../src/backend.js";
import type {
  DescribeInput,
  ElementDescription,
  ElementSummary,
  FindInput,
  LibraryInput,
  QueryAnswer,
} from "../src/queries.js";
import type { ModelDocument } from "../src/snapshot.js";

const identity = { name: "ContractFixture", version: "17.test" };
const evidence: ValidationEvidence = {
  library: { name: "Fixture library", identity: "fixture-library-edition", version: "2.test" },
  completeness: {
    parse: "incomplete",
    libraryLoad: "complete",
    resolution: "unknown",
    reasons: ["Programmed fixture evidence; no semantic analysis was performed."],
  },
  checks: { performed: ["Fixture response only"], notProven: ["All language semantics"] },
};
function element(name: string): ElementSummary {
  return { id: name, name, qualifiedName: name, kind: "fixture", owner: null, documentation: null };
}

/** NON-SEMANTIC fixture. Exercises the contract; does not parse or validate SysML. */
class AlternateBackend implements LanguageBackend {
  readonly id = "contract-fixture";
  interfaceVersion = LANGUAGE_ENGINE_INTERFACE_VERSION;
  generation = 0;
  connected = false;
  capabilities: BackendCapability[] = [
    "validate",
    "find_element",
    "describe_element",
    "library_lookup",
  ];
  readonly documents: ModelDocument[][] = [];
  readonly calls: { method: string; model: ModelHandle; input: unknown }[] = [];
  libraryOpens = 0;
  closeCalls = 0;
  reconnectDuringFind = false;
  reconnectAfterValidation = false;
  readonly scopes = new WeakMap<ModelHandle, "project" | "library">();
  diagnostics: BackendDiagnostic[] = [
    {
      file: "model/main.sysml",
      line: 1,
      column: 2,
      severity: "error",
      category: "FIXTURE_DIAGNOSTIC",
      message: "unresolved reference: fixture text only",
      raw: { diagnosticNumber: 901, byteOffset: 3, payload: { fixture: true } },
    },
    {
      file: "model/main.sysml",
      line: 1,
      column: 4,
      severity: "warning",
      category: "FIXTURE_WARNING",
      message: "Programmed warning",
      raw: { diagnosticNumber: 902 },
    },
  ];
  async start(): Promise<BackendInfo> {
    if (!this.connected) {
      this.generation += 1;
      this.connected = true;
    }
    return { engine: identity, capabilities: this.capabilities };
  }
  async validate(documents: readonly ModelDocument[]): Promise<BackendValidation> {
    this.documents.push(documents.map((document) => ({ ...document })));
    const model = this.handle("project");
    // Reconnect after delivering the handle, while the product rereads saved files.
    if (this.reconnectAfterValidation) setImmediate(() => this.simulateReconnect());
    return { model, diagnostics: this.diagnostics, evidence };
  }
  async openLibrary(): Promise<ModelHandle> {
    this.libraryOpens += 1;
    return this.handle("library");
  }
  async findElement(model: ModelHandle, input: FindInput): Promise<QueryAnswer<ElementSummary>> {
    this.calls.push({ method: "find", model, input });
    if (this.reconnectDuringFind) this.simulateReconnect();
    return {
      items: input.name === "NoMatches" ? [] : [element("ProjectOne"), element("ProjectTwo")],
      limitations: [],
    };
  }
  async describeElement(
    model: ModelHandle,
    input: DescribeInput,
  ): Promise<QueryAnswer<ElementDescription>> {
    this.calls.push({ method: "describe", model, input });
    return {
      items: [
        {
          element: element(input.qualifiedName),
          nativeKind: "fixture-description",
          typeInfo: null,
          multiplicity: null,
          typedBy: [],
          declaredSpecializations: [],
          generalizations: [],
          features: [],
          metadata: [],
          relationships: [],
        },
      ],
      limitations: ["This programmed fixture provides no semantic coverage."],
    };
  }
  async libraryLookup(
    model: ModelHandle,
    input: LibraryInput,
  ): Promise<QueryAnswer<ElementSummary>> {
    this.calls.push({ method: "library", model, input });
    return { items: [element("LibraryOne"), element("LibraryTwo")], limitations: [] };
  }
  close(): void {
    this.closeCalls += 1;
    this.connected = false;
  }
  simulateReconnect(): void {
    this.generation += 1;
    this.connected = true;
  }
  private handle(scope: "project" | "library"): ModelHandle {
    const model = Object.freeze({ generation: this.generation });
    this.scopes.set(model, scope);
    return model;
  }
}

function alternateProvider(backend: AlternateBackend): LanguageEngineProvider {
  return {
    id: backend.id,
    interfaceVersion: LANGUAGE_ENGINE_INTERFACE_VERSION,
    defaultEngineVersion: identity.version,
    createBackend: () => backend,
    languageService: {
      id: backend.id,
      interfaceVersion: LANGUAGE_ENGINE_INTERFACE_VERSION,
      version: { args: [], matchesOutput: () => false },
      launch: { args: [], environment: () => ({}) },
      standardLibrary: {
        scheme: "contract-fixture",
        storageKeyPrefix: "contract-fixture-library",
        supports: () => false,
        request: () => {
          throw new Error("No editor protocol in this non-semantic fixture.");
        },
        decode: () => undefined,
      },
    },
  };
}

const sessions: ProjectSession[] = [];
const folders: string[] = [];
async function project(backend = new AlternateBackend()) {
  const root = await mkdtemp(join(tmpdir(), "systrace-contract-"));
  folders.push(root);
  await mkdir(join(root, "model"));
  await writeFile(join(root, "model/main.sysml"), "package Fixture { part def Example; }");
  const options = {
    projectRoot: root,
    engine: { executable: "unused-contract-fixture", timeoutMs: 1500 },
  };
  const session = new ProjectSession(options, backend);
  sessions.push(session);
  return { root, session, backend, options };
}
afterEach(async () => {
  sessions.splice(0).forEach((session) => session.close());
  for (const folder of folders.splice(0)) {
    if (
      dirname(folder) !== resolve(tmpdir()) ||
      !folder.startsWith(resolve(tmpdir()) + sep + "systrace-contract-")
    )
      throw new Error("Unexpected contract-test folder");
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("replaceable language backend (non-semantic contract tests)", () => {
  it("preserves alternate engine identity, diagnostic meaning and completeness evidence", async () => {
    const { session, backend } = await project();
    const result = await session.validate();
    expect(result.engine).toEqual(identity);
    expect(result.library).toEqual(evidence.library);
    expect(result.completeness).toEqual(evidence.completeness);
    expect(result.checks).toEqual(evidence.checks);
    expect(result.project).toEqual({ errors: 1, warnings: 1 });
    expect(result.status).toBe("errors");
    expect(result.diagnostics[0]).toMatchObject(backend.diagnostics[0]!);
    expect(result.diagnostics[0]?.category).toBe("FIXTURE_DIAGNOSTIC");
    expect(result.diagnostics[0]?.raw).not.toHaveProperty("span");
    expect(backend.documents).toEqual([
      [
        {
          name: "model/main.sysml",
          language: "sysml",
          content: "package Fixture { part def Example; }",
        },
      ],
    ]);
  });

  it("does not infer complete validation from an alternate backend's empty diagnostic list", async () => {
    const backend = new AlternateBackend();
    backend.diagnostics = [];
    const { session } = await project(backend);
    const result = await session.validate();
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.completeness).toEqual(evidence.completeness);
    expect(result.checks.notProven).toEqual(["All language semantics"]);
  });

  it("dispatches all three queries with opaque handles and preserves query limitations", async () => {
    const { session, backend } = await project();
    const find = {
      specializes: "FixtureBase",
      metadata: { type: "FixtureTag", values: { approved: true } },
    };
    const description = { qualifiedName: "ProjectOne", includeInherited: true };
    const library = { namespace: "FixtureLibrary", name: "Library", kind: "fixture" };
    const found = await session.findElement(find);
    const described = await session.describeElement(description);
    const referenced = await session.libraryLookup(library);
    expect(backend.calls.map(({ method, input }) => ({ method, input }))).toEqual([
      { method: "find", input: find },
      { method: "describe", input: description },
      { method: "library", input: library },
    ]);
    expect(backend.calls[0]?.model).toBe(backend.calls[1]?.model);
    expect(backend.calls[2]?.model).not.toBe(backend.calls[0]?.model);
    expect(backend.scopes.get(backend.calls[0]!.model)).toBe("project");
    expect(backend.scopes.get(backend.calls[2]!.model)).toBe("library");
    expect(found.engine).toEqual(identity);
    expect(described.engine).toEqual(identity);
    expect(referenced.engine).toEqual(identity);
    expect(described.status).toBe("partial");
    expect(described.limitations).toEqual([
      "This programmed fixture provides no semantic coverage.",
    ]);
    expect(referenced.validation).toBeNull();
    expect(referenced.content.projectRevision).toBeNull();
    expect(backend.documents).toHaveLength(1);
  });

  it("opens library context without loading project files and keeps it independent of project edits", async () => {
    const { root, session, backend } = await project();
    const first = await session.libraryLookup({ namespace: "FixtureLibrary", limit: 1 });
    expect(backend.documents).toHaveLength(0);
    expect(backend.libraryOpens).toBe(1);
    const libraryModel = backend.calls[0]!.model;
    await writeFile(join(root, "model/main.sysml"), "package Changed { part def Other; }");
    await session.validate();
    const second = await session.libraryLookup({ cursor: first.nextCursor! });
    expect(second.items).toEqual([element("LibraryTwo")]);
    await session.libraryLookup({ namespace: "FixtureLibrary" });
    expect(backend.calls.at(-1)?.model).toBe(libraryModel);
    expect(backend.libraryOpens).toBe(1);
  });

  it("distinguishes an unsupported query from a supported query with no matches", async () => {
    const backend = new AlternateBackend();
    backend.capabilities = ["validate", "find_element", "library_lookup"];
    const { session } = await project(backend);
    const empty = await session.findElement({ name: "NoMatches" });
    expect(empty).toMatchObject({ status: "answered", total: 0, items: [], limitations: [] });
    await expect(session.describeElement({ qualifiedName: "ProjectOne" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    expect(backend.calls.map(({ method }) => method)).toEqual(["find"]);
  });

  it("rejects unsupported validation before invoking the backend", async () => {
    const backend = new AlternateBackend();
    backend.capabilities = ["library_lookup"];
    const { session } = await project(backend);
    await expect(session.validate()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(backend.documents).toEqual([]);
    expect((await session.libraryLookup({ namespace: "FixtureLibrary" })).total).toBe(2);
  });

  it("invalidates diagnostic, project-query and library cursors when the backend reconnects", async () => {
    const { session, backend } = await project();
    const diagnostic = await session.validate({ limit: 1 });
    const query = await session.findElement({ limit: 1 });
    const library = await session.libraryLookup({ namespace: "FixtureLibrary", limit: 1 });
    backend.simulateReconnect();
    await expect(session.validate({ cursor: diagnostic.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    await expect(session.findElement({ cursor: query.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    await expect(session.libraryLookup({ cursor: library.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    const fresh = await session.findElement();
    expect(fresh.content.projectRevision).toBeGreaterThan(query.content.projectRevision!);
    expect(backend.documents).toHaveLength(2);
    await session.libraryLookup({ namespace: "FixtureLibrary" });
    expect(backend.libraryOpens).toBe(2);
  });

  it("rejects a reconnect during the saved-file reread without publishing a revision", async () => {
    const { root, session, backend } = await project();
    const baseline = await session.validate();
    await writeFile(join(root, "model/main.sysml"), "package Revised { part def Other; }");
    backend.reconnectAfterValidation = true;
    await expect(session.validate()).rejects.toMatchObject({ code: "STALE_MODEL" });
    expect(backend.documents).toHaveLength(2);
    backend.reconnectAfterValidation = false;
    const recovered = await session.validate();
    expect(recovered.content.projectRevision).toBe(baseline.content.projectRevision + 1);
    expect(recovered.content.files).toEqual([{ file: "model/main.sysml", revision: 2 }]);
    expect(backend.documents).toHaveLength(3);
    const query = await session.findElement();
    expect(query.total).toBe(2);
    expect(query.content.projectRevision).toBe(recovered.content.projectRevision);
    expect(backend.calls.at(-1)?.model.generation).toBe(backend.generation);
    expect(backend.documents).toHaveLength(3);
  });

  it("rejects an answer produced while its backend model generation changes", async () => {
    const { session, backend } = await project();
    backend.reconnectDuringFind = true;
    await expect(session.findElement()).rejects.toMatchObject({ code: "STALE_MODEL" });
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.model.generation).toBeLessThan(backend.generation);
    backend.reconnectDuringFind = false;
    expect((await session.findElement()).total).toBe(2);
    expect(backend.documents).toHaveLength(2);
    expect(backend.calls[1]!.model.generation).toBe(backend.generation);
  });

  it("rejects cursors from another project session even with identical backend identities", async () => {
    const a = await project(),
      b = await project();
    const diagnostic = await a.session.validate({ limit: 1 });
    const query = await a.session.findElement({ limit: 1 });
    const library = await a.session.libraryLookup({ namespace: "FixtureLibrary", limit: 1 });
    await expect(b.session.validate({ cursor: diagnostic.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    await expect(b.session.findElement({ cursor: query.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    await expect(b.session.libraryLookup({ cursor: library.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    expect(a.backend.documents).toHaveLength(1);
    expect(b.backend.documents).toHaveLength(0);
  });

  it("rejects an incompatible backend interface before starting a process", async () => {
    const { options } = await project();
    const backend = new AlternateBackend();
    backend.interfaceVersion = LANGUAGE_ENGINE_INTERFACE_VERSION + 1;
    expect(() => new ProjectSession(options, backend)).toThrowError(AdapterError);
    try {
      new ProjectSession(options, backend);
    } catch (error) {
      expect(error).toMatchObject({ code: "ENGINE_PROTOCOL_ERROR" });
    }
    expect(backend.connected).toBe(false);
    expect(backend.documents).toEqual([]);
  });
});

describe("backend integration boundaries", () => {
  it("rejects fabricated, foreign, wrong-scope and previous-generation OpenSysML handles", async () => {
    const options = {
      executable: process.execPath,
      args: [fileURLToPath(new URL("./query-engine.mjs", import.meta.url))],
      timeoutMs: 1500,
    };
    const first = new OpenSysMLBackend(options);
    const second = new OpenSysMLBackend(options);
    const signal = new AbortController().signal;
    const documents: ModelDocument[] = [{ name: "fixture.sysml", language: "sysml", content: "" }];
    try {
      const own = await first.validate(documents);
      const foreign = await second.validate(documents);
      const library = await first.openLibrary();
      expect((await first.findElement(own.model, {}, signal)).items).toHaveLength(3);
      expect((await first.libraryLookup(library, { namespace: "P" }, signal)).items).toHaveLength(
        3,
      );
      for (const model of [
        Object.freeze({ generation: first.generation }),
        foreign.model,
        library,
      ]) {
        await expect(first.findElement(model, {}, signal)).rejects.toMatchObject({
          code: "STALE_MODEL",
        });
      }
      await expect(
        first.libraryLookup(own.model, { namespace: "P" }, signal),
      ).rejects.toMatchObject({ code: "STALE_MODEL" });
      await expect(first.findElement(own.model, { name: "Crash" }, signal)).rejects.toMatchObject({
        code: "ENGINE_UNAVAILABLE",
      });
      await first.start();
      await expect(
        first.describeElement(own.model, { qualifiedName: "P::First" }, signal),
      ).rejects.toMatchObject({ code: "STALE_MODEL" });
      await expect(first.libraryLookup(library, { namespace: "P" }, signal)).rejects.toMatchObject({
        code: "STALE_MODEL",
      });
      const fresh = await first.validate(documents);
      expect((await first.findElement(fresh.model, {}, signal)).items).toHaveLength(3);
    } finally {
      first.close();
      second.close();
    }
  });

  it("rejects and disposes a backend that belongs to a different provider", async () => {
    const backend = new AlternateBackend();
    await backend.start();
    const fixture = alternateProvider(backend);
    const mismatched: LanguageEngineProvider = {
      ...fixture,
      id: "different-provider",
      languageService: { ...fixture.languageService, id: "different-provider" },
    };
    expect(() =>
      createLanguageBackend(mismatched, { executable: "unused-contract-fixture" }),
    ).toThrowError(expect.objectContaining({ code: "ENGINE_PROTOCOL_ERROR" }));
    expect(backend.closeCalls).toBe(1);
    expect(backend.connected).toBe(false);
    expect(backend.documents).toEqual([]);
  });

  it("keeps four MCP tool schemas and dispatches an alternate provider over an MCP connection", async () => {
    const { options } = await project();
    const backend = new AlternateBackend();
    const provider = alternateProvider(backend);
    const server = createServer(options, provider);
    const client = new Client({ name: "contract-test-client", version: "1.test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "describe_element",
        "find_element",
        "library_lookup",
        "validate",
      ]);
      const expectedFields: Record<string, string[]> = {
        validate: ["cursor", "limit", "paths"],
        find_element: [
          "cursor",
          "kind",
          "limit",
          "metadata",
          "name",
          "qualifiedName",
          "scope",
          "specializes",
        ],
        describe_element: ["includeInherited", "qualifiedName"],
        library_lookup: ["cursor", "kind", "limit", "name", "namespace", "qualifiedName"],
      };
      for (const tool of listed.tools) {
        expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
          expectedFields[tool.name],
        );
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
        if (tool.name !== "describe_element") {
          expect(tool.inputSchema.properties?.limit).toMatchObject({ minimum: 1, maximum: 500 });
        } else {
          expect(tool.inputSchema.required).toEqual(["qualifiedName"]);
          expect(tool.inputSchema.properties?.includeInherited).toMatchObject({ type: "boolean" });
        }
      }
      const calls = [
        { name: "validate", arguments: {} },
        { name: "find_element", arguments: { name: "NoMatches" } },
        { name: "describe_element", arguments: { qualifiedName: "ProjectOne" } },
        { name: "library_lookup", arguments: { namespace: "FixtureLibrary" } },
      ];
      for (const call of calls) {
        const result = await client.callTool(call);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ engine: identity });
      }
      expect(backend.documents).toHaveLength(1);
      expect(backend.calls.map(({ method }) => method)).toEqual(["find", "describe", "library"]);
    } finally {
      await client.close();
      await server.close();
    }
    expect(backend.connected).toBe(false);
  });
});
