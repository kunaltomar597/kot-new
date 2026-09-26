/**
 * Signs a person out after a period without input (AUTH-005, client side), warning first. The
 * server applies the same timeout; the app ends the session itself so a shared POS never stays
 * signed in on screen. Input also keeps the server session alive (`onKeepAlive`), because tapping
 * around a screen that makes no calls is still activity.
 */
export interface InactivityOptions {
  readonly timeoutMs: number;
  /** How long before the end the warning shows. */
  readonly warnMs: number;
  /** Least time between keep-alive calls. */
  readonly keepAliveMs: number;
  readonly onWarn: (secondsLeft: number) => void;
  readonly onActive: () => void;
  readonly onExpire: () => void;
  readonly onKeepAlive: () => void;
  readonly now?: () => number;
}

export class InactivityTracker {
  private lastInput: number;
  private lastKeepAlive: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warning = false;
  private stopped = false;

  constructor(private readonly options: InactivityOptions) {
    this.lastInput = this.now();
    this.lastKeepAlive = this.lastInput;
    this.schedule();
  }

  /** The person touched, clicked or typed. */
  activity(): void {
    if (this.stopped) return;
    const now = this.now();
    this.lastInput = now;
    if (this.warning) {
      this.warning = false;
      this.options.onActive();
    }
    if (now - this.lastKeepAlive >= this.options.keepAliveMs) {
      this.lastKeepAlive = now;
      this.options.onKeepAlive();
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private tick(): void {
    if (this.stopped) return;
    const left = this.options.timeoutMs - (this.now() - this.lastInput);
    if (left <= 0) {
      this.stop();
      this.options.onExpire();
      return;
    }
    if (left <= this.options.warnMs) {
      this.warning = true;
      this.options.onWarn(Math.ceil(left / 1000));
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const left = this.options.timeoutMs - (this.now() - this.lastInput);
    // Once warning, count down every second; before that, wake when the warning is due.
    const delay = left <= this.options.warnMs ? Math.min(1_000, left) : left - this.options.warnMs;
    this.timer = setTimeout(
      () => {
        this.tick();
      },
      Math.max(0, delay),
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
