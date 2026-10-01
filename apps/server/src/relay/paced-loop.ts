/**
 * A self-scheduling loop for the relay's sync agent (P5-03). Each run says when the next is due.
 * - A failed run backs off: `retryBaseMs`, doubling, up to `retryMaxMs`.
 * - A change can bring the next run forward, except while backing off.
 * - `run()` during a run waits for it and runs once more, shared by every caller meanwhile, so
 *   whatever changed before the call is included.
 */
export class PacedLoop {
  private timer: NodeJS.Timeout | undefined;
  private nextAt = Number.POSITIVE_INFINITY;
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  private failures = 0;
  private stopped = false;

  constructor(
    /** One run; resolves with the delay until the next one. */
    private readonly work: () => Promise<number>,
    private readonly options: { readonly retryBaseMs: number; readonly retryMaxMs: number },
    /** Told about each failure (the loop itself never throws). */
    private readonly onFailure: (error: unknown) => void,
  ) {}

  /** Consecutive failed runs (0 when the last one worked). */
  get failing(): number {
    return this.failures;
  }

  start(firstDelayMs: number): void {
    this.schedule(firstDelayMs, true);
  }

  /** Brings the next run within `delayMs`, unless backing off after a failure. */
  soon(delayMs: number): void {
    this.schedule(delayMs, false);
  }

  /** Runs now (or right after the current run) and resolves when that run is done. */
  run(): Promise<void> {
    if (this.running === undefined) return this.begin();
    this.queued ??= this.running.then(() => {
      this.queued = undefined;
      return this.begin();
    });
    return this.queued;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.queued;
    await this.running;
  }

  private begin(): Promise<void> {
    this.running = this.once().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async once(): Promise<void> {
    let next: number;
    try {
      next = await this.work();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      this.onFailure(error);
      next = Math.min(this.options.retryBaseMs * 2 ** (this.failures - 1), this.options.retryMaxMs);
    }
    this.schedule(next, true);
  }

  private schedule(delayMs: number, fromLoop: boolean): void {
    if (this.stopped) return;
    if (this.failures > 0 && !fromLoop) return;
    const at = Date.now() + delayMs;
    // Only ever sooner: a change that arrived during a run keeps its earlier slot.
    if (at >= this.nextAt) return;
    clearTimeout(this.timer);
    this.nextAt = at;
    this.timer = setTimeout(() => {
      this.nextAt = Number.POSITIVE_INFINITY;
      void this.run();
    }, delayMs);
    this.timer.unref();
  }
}
