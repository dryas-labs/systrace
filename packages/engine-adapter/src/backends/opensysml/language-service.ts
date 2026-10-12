// SPDX-License-Identifier: Apache-2.0
import type { LanguageServiceBackend } from "../../language-service.js";
import { engineEnvironment } from "./connection.js";

/** OpenSysML-specific LSP switches and bundled-source extension. */
export const OPEN_SYSML_LANGUAGE_SERVICE: LanguageServiceBackend = {
  id: "opensysml",
  interfaceVersion: 1,
  version: {
    args: ["-version"],
    matchesOutput: (stdout, expectedVersion) =>
      stdout.split(/\r?\n/)[0] === `sysml-lsp ${expectedVersion}`,
  },
  launch: {
    args: ["-strict", "-no-record-cache"],
    environment: engineEnvironment,
  },
  standardLibrary: {
    scheme: "sysml-stdlib",
    // Preserve existing OpenSysML library tabs when adopting the adapter boundary.
    storageKeyPrefix: "dryas.stdlib",
    supports(capabilities) {
      if (!capabilities || typeof capabilities !== "object" || !("experimental" in capabilities))
        return false;
      const experimental = capabilities.experimental;
      return (
        !!experimental &&
        typeof experimental === "object" &&
        "openSysmlStdlibContent" in experimental &&
        experimental.openSysmlStdlibContent === true
      );
    },
    request: (uri) => ({ method: "opensysml/stdlibContent", params: { uri } }),
    decode: (result) =>
      result && typeof result === "object" && "text" in result && typeof result.text === "string"
        ? result.text
        : undefined,
  },
};
