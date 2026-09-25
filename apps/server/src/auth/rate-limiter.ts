import { Injectable } from '@nestjs/common';

/**
 * In-memory sliding-window rate limiter (SEC-009). The local server is a single process, so memory
 * is enough; limits reset when it restarts, which only ever makes them more lenient for a moment.
 */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Records an attempt for `key`; false when `limit` attempts already happened within `windowMs`. */
  attempt(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now, windowMs);
    return true;
  }

  private prune(now: number, windowMs: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= windowMs)) this.hits.delete(key);
    }
  }
}
