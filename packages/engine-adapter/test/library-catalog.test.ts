// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { readLibraryCatalog } from "../src/backends/opensysml/library-catalog.js";

const scratch = "file:///fixture-storage/library-query.sysml";
const range = { start: { line: 2, character: 0 }, end: { line: 20, character: 1 } };

it("uses engine namespace completions and definition locations, excluding project declarations", async () => {
  const notify = vi.fn(async () => {});
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      isIncomplete: false,
      items: [
        { label: "Local", kind: 9 },
        { label: "SI", kind: 9 },
        { label: "part", kind: 14 },
      ],
    })
    .mockResolvedValueOnce([{ uri: "file:///project/local.sysml", range }])
    .mockResolvedValueOnce([
      {
        targetUri: "sysml-stdlib:///Units/SI.sysml",
        targetRange: range,
        targetSelectionRange: range,
      },
    ]);
  expect(await readLibraryCatalog({ request, notify }, scratch)).toEqual([
    { name: "SI", uri: "sysml-stdlib:///Units/SI.sysml", range },
  ]);
  expect(notify).toHaveBeenLastCalledWith("textDocument/didClose", {
    textDocument: { uri: scratch },
  });
});

it("closes the unsaved query document after an engine failure and refuses a partial catalogue", async () => {
  for (const response of [
    Promise.reject(new Error("engine disconnected")),
    Promise.resolve({ isIncomplete: true, items: [] }),
  ]) {
    const notify = vi.fn(async () => {});
    const request = vi.fn(() => response);
    await expect(readLibraryCatalog({ request, notify }, scratch)).rejects.toThrow();
    expect(notify).toHaveBeenLastCalledWith("textDocument/didClose", {
      textDocument: { uri: scratch },
    });
  }
});
