// SPDX-License-Identifier: Apache-2.0
import type { LanguageServiceBackend } from "@dryas/engine-adapter";

// A deliberately different protocol, used only to exercise the adapter boundary.
// This fixture does not implement SysML semantics or represent a product engine.
export const TEST_LANGUAGE_SERVICE: LanguageServiceBackend = {
  id: "fixture-language-engine",
  interfaceVersion: 1,
  version: {
    args: ["-e", "console.log(JSON.stringify({build: process.env.DRYAS_TEST_LANGUAGE_BUILD}))"],
    matchesOutput: (stdout, expectedVersion) => {
      try {
        return JSON.parse(stdout).build === expectedVersion;
      } catch {
        return false;
      }
    },
  },
  launch: {
    args: ["--fixture-language-server"],
    environment: () => ({ ...process.env, DRYAS_TEST_LANGUAGE_BUILD: "fixture-build" }),
  },
  standardLibrary: {
    scheme: "fixture-library",
    storageKeyPrefix: "dryas.fixture-library",
    supports: (capabilities) =>
      !!capabilities &&
      typeof capabilities === "object" &&
      "fixtureLibrary" in capabilities &&
      capabilities.fixtureLibrary === true,
    request: (uri) => ({ method: "fixture/librarySource", params: { document: uri } }),
    decode: (result) =>
      result &&
      typeof result === "object" &&
      "source" in result &&
      typeof result.source === "string"
        ? result.source
        : undefined,
  },
};
