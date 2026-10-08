# Engine support policy

**English** | [简体中文](engine-support.zh-Hans.md)

Systrace prioritizes and tests designated builds of [dryas-labs/OpenSysML](https://github.com/dryas-labs/OpenSysML), an independently maintained derivative of [Open-MBEE/OpenSysML](https://github.com/Open-MBEE/OpenSysML). This does not imply upstream endorsement.

## Supported builds and upstream compatibility

The tested engine version and source revision are recorded in [config/engine.json](../config/engine.json). Updating a branch or merging an upstream PR does not automatically update the installed engine or establish compatibility with a new upstream release.

| Engine                    | Current support                                                         |
| ------------------------- | ----------------------------------------------------------------------- |
| Configured DRYAS build    | Primary integration target; tested on Windows and Linux in Systrace CI. |
| Upstream Open-MBEE builds | Compatibility goal; not currently an interchangeable, tested backend.   |
| Other builds              | Unverified; the current version check may reject them.                  |

The current adapter checks the configured version and required capabilities. Some model-query tools depend on DRYAS-specific stdio APIs. Do not change the expected-version setting alone and describe the result as upstream compatibility. Standard LSP interoperability and capability-based fallback are goals, not claims that every upstream build already works.

A future supported upstream build must pass the same applicable editor, validation and model-query tests. Any unavailable optional features must be documented explicitly. Failures must not be disguised as successful validation.

## Upstream contributions

DRYAS will continue proposing suitable fixes and general improvements to upstream through PRs. Acceptance, requested revisions and release timing remain under upstream maintainers' control. Product-specific or experimental interfaces may remain downstream while their design evolves.

Submitted, merged, released and tested are separate states. Contribution status belongs in the engine repository's maintenance records; Systrace compatibility is established by its own tested build configuration. DRYAS is responsible for support and releases of its maintained builds.

## Licenses and distribution

Preserve applicable upstream licenses, copyright notices and attribution. Modified upstream files must carry clear modification notices; commit history and an SPDX identifier alone do not replace them. Preserve applicable upstream NOTICE content in distributions, and document downstream changes separately.

The engine source uses Apache-2.0, but its bundled library has separate terms: the OMG-derived SysML/KerML standard library is covered by EPL-2.0, while the OpenSysML-specific library extensions are covered by Apache-2.0. See the engine's [library NOTICE](https://github.com/dryas-labs/OpenSysML/blob/main/internal/workspace/libs/stdlib/NOTICE). Dependencies must be assessed individually.

The current VSIX does not include the engine executables or standard library. Any future engine bundle needs its own license and notice inventory, including applicable standard-library source availability obligations. Publishing a fork or submitting PRs does not replace these requirements. Retain original legal texts; translations of these support documents do not change license terms.
