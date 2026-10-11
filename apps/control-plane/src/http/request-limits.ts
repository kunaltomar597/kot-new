import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { mapError } from '../errors/cp-exception.filter.js';
import { CpError } from '../errors/cp-error.js';

/** What the Control Plane lets one client address do (threat CP-D1). */
export interface RequestLimits {
  /** Requests an address may make at once, then refilled at `perSecond`; 0 turns the limit off. */
  readonly burst: number;
  readonly perSecond: number;
  /** The same for the pages and files anyone on the internet opens without a credential. */
  readonly publicBurst: number;
  readonly publicPerSecond: number;
}

const MAX_TRACKED_ADDRESSES = 20_000;
/** Digital bills (`/v1/bills/<token>`): a diner opens one a few times, nobody opens hundreds. */
const PUBLIC_PATH = /^\/v1\/bills(?:\/|$)/;
/** The load balancer's health probe, which comes from one address all day. */
const HEALTH_PATH = /^\/v1\/health(?:\/|$)/;

interface Bucket {
  tokens: number;
  at: number;
}

/** A token bucket per client address; one that has refilled completely is forgotten. */
class AddressBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {}

  /** Takes one token; the seconds to wait when there is none. */
  take(address: string, now: number): number {
    if (this.buckets.size >= MAX_TRACKED_ADDRESSES) this.forgetFull(now);
    const bucket = this.buckets.get(address) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond,
    );
    bucket.at = now;
    this.buckets.set(address, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.perSecond));
  }

  private forgetFull(now: number): void {
    for (const [address, bucket] of this.buckets) {
      if (bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond >= this.burst) {
        this.buckets.delete(address);
      }
    }
    // A flood from more addresses than that: start again rather than grow without end.
    if (this.buckets.size >= MAX_TRACKED_ADDRESSES) this.buckets.clear();
  }
}

/**
 * Early in the pipeline, before any body is read: an address that asks too fast gets 429
 * `RATE_LIMITED` with `Retry-After` (CP-D1). The address is the client's when `trust proxy` is
 * set to the number of proxies in front. Memory of each instance; the edge in front of the service
 * (`infra/edge`) limits across instances.
 */
export function requestLimitMiddleware(
  limits: RequestLimits,
  clock: () => number = Date.now,
): RequestHandler {
  if (limits.burst === 0) {
    return (_request, _response, next) => {
      next();
    };
  }
  const general = new AddressBuckets(limits.burst, limits.perSecond);
  const open = new AddressBuckets(limits.publicBurst, limits.publicPerSecond);
  return (request: Request, response: Response, next: NextFunction) => {
    if (HEALTH_PATH.test(request.path)) {
      next();
      return;
    }
    const address = request.ip ?? 'unknown';
    const now = clock();
    const wait = Math.max(
      PUBLIC_PATH.test(request.path) ? open.take(address, now) : 0,
      general.take(address, now),
    );
    if (wait === 0) {
      next();
      return;
    }
    const mapped = mapError(
      new CpError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.'),
      (request as Request & { id?: unknown }).id as string | undefined,
    );
    response.setHeader('retry-after', String(wait));
    response.status(mapped.status).json(mapped.body);
  };
}
