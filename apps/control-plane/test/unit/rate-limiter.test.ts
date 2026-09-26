import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/auth/rate-limiter.js';

describe('[SEC-009] enrolment rate limit', () => {
  it('allows the limit per window and key, then refuses until the window ends', () => {
    const limiter = new RateLimiter();
    const results = Array.from({ length: 11 }, () => limiter.hit('enrol:10.0.0.1', 10, 60_000, 0));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
    expect(limiter.hit('enrol:10.0.0.2', 10, 60_000, 0)).toBe(true);
    expect(limiter.hit('enrol:10.0.0.1', 10, 60_000, 60_000)).toBe(true);
  });
});
