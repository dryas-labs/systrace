// SPDX-License-Identifier: Apache-2.0
export type RefreshReason =
  | "activation"
  | "configuration"
  | "workspace"
  | "trust"
  | "document-opened"
  | "manual-restart"
  | "validation"
  | "engine-recovery";

// Keep one pending batch while a refresh runs. Read effective settings in the
// callback, so a burst never queues restarts with obsolete configurations.
export class RefreshQueue {
  private reasons = new Set<RefreshReason>();
  private waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private due = 0;
  private disposed = false;

  constructor(
    private readonly run: (reasons: ReadonlySet<RefreshReason>) => Promise<void>,
    private readonly failed: () => void,
  ) {}

  request(reason: RefreshReason, delay = 0): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const empty = !this.reasons.size;
    this.reasons.add(reason);
    if (delay > 0 || empty || ["manual-restart", "validation", "engine-recovery"].includes(reason))
      this.due = Date.now() + delay;
    const promise = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.arm();
    return promise;
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.running || !this.reasons.size) return;
    this.timer = setTimeout(() => this.drain(), Math.max(0, this.due - Date.now()));
  }

  private drain(): void {
    if (this.disposed || this.running || !this.reasons.size) return;
    const reasons = this.reasons;
    const waiters = this.waiters;
    this.reasons = new Set();
    this.waiters = [];
    this.running = Promise.resolve()
      .then(() => this.run(reasons))
      .catch(() => this.failed())
      .finally(() => {
        this.running = undefined;
        waiters.forEach((resolve) => resolve());
        this.arm();
      });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.timer);
    this.reasons.clear();
    this.waiters.splice(0).forEach((resolve) => resolve());
    await this.running;
  }
}
