# Language-engine interface

**English** | [简体中文](language-engine-interface.zh-Hans.md)

Systrace uses a language-engine provider to connect its saved-model tools and editor
integration to the same language engine.
The interface is an internal TypeScript contract, not a new public network protocol
or a claim that an arbitrary engine can be substituted without integration work.

## Contract and implementation

| Component                | Responsibility                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `LanguageEngineProvider` | Backend identity, interface version, default engine version, model-backend factory and language-service description |
| `LanguageBackend`        | Engine startup, saved-model validation, model queries, isolated library model and shutdown                          |
| `LanguageServiceBackend` | LSP version-command arguments and output check, launch arguments/environment, standard-library document protocol    |
| `ProjectSession`         | Saved files, immutable snapshots, project revisions, request queue, result limits and pagination                    |
| Backend implementation   | Native process transport, RPC schemas, required capabilities, diagnostic mapping and native query translation       |

The contracts live in `packages/engine-adapter/src/backend.ts`, `provider.ts` and
`language-service.ts`. Engine-specific implementation details live under
`packages/engine-adapter/src/backends`. Product composition is centralized in
`packages/engine-adapter/src/default-engine.ts`, which exports
`DEFAULT_LANGUAGE_ENGINE_PROVIDER`.

`interfaceVersion: 1` identifies the adapter contract. It is independent of the native
engine release, which is checked against the configured tested build. The provider
and its language service must agree on their identity and interface version.
`createLanguageBackend(provider, options)` also checks that the created model backend
agrees with the provider identity and supported interface version. API and LSP remain separate processes; sharing a provider does not combine their model state.
No fallback to a different engine is performed.

## Model-backend operations

| Operation                               | Result or effect                                                       |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `start(signal?)`                        | Engine name/version and advertised product capabilities                |
| `validate(documents, signal?)`          | Model handle, diagnostics and validation evidence for supplied sources |
| `openLibrary(signal?)`                  | Handle for an isolated bundled-library model                           |
| `findElement(model, input, signal)`     | Matching model elements, with explicit limitations                     |
| `describeElement(model, input, signal)` | Model description, with explicit limitations                           |
| `libraryLookup(model, input, signal)`   | Library lookup/browse result, with explicit limitations                |
| `close()`                               | Dispose of the backend session                                         |

These operations serve the existing MCP tools `validate`, `find_element`,
`describe_element` and `library_lookup`. Their input schemas and current response
behavior are preserved. The common interface exposes language operations and opaque
model handles. Native RPC names, arbitrary RPC invocation and native model identifiers
remain inside the backend implementation.

The older `engine.ts` transport exports remain as compatibility exports for existing
development clients. They are backend-specific; new product code should use the
language-engine contract rather than those low-level transport exports.

This is a language-analysis contract. It does not include executing a model,
simulation, a TypeScript parser or a second name resolver.

## Identity and snapshot scope

`ModelHandle` is an opaque object owned by the backend that created it and bound to
that backend's process generation. Callers must retain the returned object, not
construct one from its visible generation number. A handle from another instance
or an earlier process generation is invalid. The generation is lifecycle information,
not an engine-independent model identifier.

`ProjectSession` associates model results with the saved snapshot and project revision.
It rereads saved sources after an operation and rejects results if the project changed.
Query cursors also bind their query arguments and backend generation; a restart or
project change requires a new query. Library queries use a separate model so project
declarations cannot shadow bundled-library results.

Element IDs and qualified names describe the owning backend's model. They are not
promised to remain stable across edits, renaming, engine restarts or engine replacement.
Fields such as `nativeKind` and raw diagnostic details retain provider-specific meaning.
This interface does not establish a universal metamodel vocabulary.

## Evidence and failure behavior

Diagnostics keep their severity, message, source location, category and raw native
details. Backend-specific category mapping stays with its implementation. Unknown
categories remain `UNCLASSIFIED`; moving that mapping does not change it.

Public API diagnostic `line` and `column` use 1-based line numbers and 1-based UTF-8
byte columns; `0` means unknown. Raw native details are retained. These coordinates
are separate from LSP positions, which follow the LSP protocol and negotiated position
encoding; callers must not treat a byte column as an editor character offset.

Validation evidence reports library identity, parse/library-load/resolution completeness,
checks performed and checks not proven. The configured language engine API does not certify
those completeness fields or independently identify the library version, so they remain
`unknown` and `null` respectively. The current public result remains `errors` when
errors exist, otherwise `incomplete`. A successful transport, a loaded model or a query
answer does not prove complete validation or engineering correctness.

An unsupported operation is distinct from an ambiguous or currently unavailable query,
a malformed response, a stale handle, cancellation and timeout. Partial answers name
their limitations. Failures must not become empty successful answers, and advertised
capabilities must not be treated as independent conformance evidence.

## Editor integration and library documents

Editor completion, hover and navigation continue to use standard LSP. The language-service
description supplies version checks, startup arguments/environment and a library document
protocol with a URI scheme, capability check, request construction and response decoding.
Its `storageKeyPrefix` provides a stable, provider-specific namespace for restored
library documents, preventing another provider from reusing the same persisted identity.
The configured service description preserves its existing storage namespace.
The extension handles project-specific editor URIs, cancellation, timeouts, refreshes and
rejection of content from a replaced connection.

The service description owns the native library URI scheme, capability checks, request
names and payload decoding. The editor document provider consumes this description
through the language-engine interface.

LSP may analyze unsaved buffers; MCP tools analyze saved files. A matching configured
engine version does not make those snapshots identical or independently certify their
bundled-library identity.

## Backend contract requirements

A provider supplies both model and language-service integration. Implementations must
validate the interface version, enforce handle ownership and lifecycle, preserve query
and evidence semantics, and pass the applicable native and host tests.

Contract tests with small injected backends check product behavior and dependency
boundaries. They do not establish language conformance or performance. See [architecture](architecture.md) and the
[language engine selection](language-engine.md) for the configured implementation.
