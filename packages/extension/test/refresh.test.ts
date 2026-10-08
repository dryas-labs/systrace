// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { RefreshQueue, type RefreshReason } from "../src/refresh.js";

afterEach(() => vi.useRealTimers());

it("coalesces setting edits and observes their latest value after the quiet period", async () => {
  vi.useFakeTimers();
  let config = "first";
  const observed: string[] = [];
  const queue = new RefreshQueue(
    async () => {
      observed.push(config);
    },
    () => {},
  );
  const first = queue.request("configuration", 750);
  await vi.advanceTimersByTimeAsync(400);
  config = "last";
  const second = queue.request("configuration", 750);
  const opened = queue.request("document-opened");
  await vi.advanceTimersByTimeAsync(749);
  expect(observed).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([first, second, opened]);
  expect(observed).toEqual(["last"]);
  await queue.dispose();
});

it("serializes refreshes and coalesces changes made during a running start", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[][] = [];
  const queue = new RefreshQueue(
    async (reasons) => {
      calls.push([...reasons]);
      if (calls.length === 1) await blocked;
    },
    () => {},
  );
  const active = queue.request("activation");
  await vi.advanceTimersByTimeAsync(0);
  const edits = Array.from({ length: 8 }, () => queue.request("configuration", 750));
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual([["activation"]]);
  release();
  await active;
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(edits);
  expect(calls).toEqual([["activation"], ["configuration"]]);
  await queue.dispose();
});

it("lets manual restart flush pending configuration once", async () => {
  vi.useFakeTimers();
  const run = vi.fn(async (_reasons: ReadonlySet<RefreshReason>) => {});
  const queue = new RefreshQueue(run, () => {});
  const pending = queue.request("configuration", 750);
  const manual = queue.request("manual-restart");
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all([pending, manual]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  expect([...run.mock.calls[0]![0]]).toEqual(["configuration", "manual-restart"]);
  await queue.dispose();
});

it("cancels scheduled work on disposal and recovers the queue after callback failure", async () => {
  vi.useFakeTimers();
  const failed = vi.fn();
  const run = vi.fn(async () => {
    throw new Error("fixture failure");
  });
  const queue = new RefreshQueue(run, failed);
  const first = queue.request("activation");
  await vi.advanceTimersByTimeAsync(0);
  await first;
  expect(failed).toHaveBeenCalledTimes(1);
  const pending = queue.request("configuration", 750);
  await queue.dispose();
  await pending;
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
});
