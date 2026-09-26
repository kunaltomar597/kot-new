import { Injectable } from '@nestjs/common';

const MAX_TRACKED_KEYS = 10_000;

/**
 * Fixed-window attempt counter per key (for example `enrol:<client address>`). In memory: each
 * instance counts on its own, which is enough with 80-bit enrolment codes (ADR-0012).
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  /** Counts an attempt; false when the key already used `limit` attempts in this window. */
  hit(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
    if (this.windows.size >= MAX_TRACKED_KEYS) this.forgetExpired(now);
    const window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  }

  private forgetExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
