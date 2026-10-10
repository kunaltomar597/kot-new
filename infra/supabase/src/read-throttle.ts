import { TABLE_TOKEN_HEADER } from '@rp/contracts/relay';
import { HttpError } from './http.js';

/**
 * How fast a table, and an address, may read (RELAY-D4): the menu, an order's status and a service
 * request's status. A page asks for the menu every 20 s and for each order every 3 s, so a table
 * of several phones reads about 2 times a second; the limits leave room for a rush and refuse a
 * script that reads as fast as it can, before the database is reached.
 */
export interface ReadLimits {
  /** Reads one table's token may make at once, then per second. */
  readonly tableBurst: number;
  readonly tablePerSecond: number;
  /** The same for one client address (a restaurant's guest Wi-Fi shares one). */
  readonly addressBurst: number;
  readonly addressPerSecond: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  tableBurst: 40,
  tablePerSecond: 5,
  addressBurst: 120,
  addressPerSecond: 20,
};

const MAX_KEYS = 20_000;

interface Bucket {
  tokens: number;
  at: number;
}

/** A token bucket per key. In the memory of one function instance, which is the point: it costs no query. */
export class KeyedBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {}

  /** Takes a token; 0 when there was one, else the seconds to wait. */
  take(key: string, now: number): number {
    if (this.buckets.size >= MAX_KEYS) this.forget(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond,
    );
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.perSecond));
  }

  private forget(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond >= this.burst) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size >= MAX_KEYS) this.buckets.clear();
  }
}

/** The caller's address as the edge saw it: Cloudflare's header, else the proxy's last entry. */
export function clientAddressOf(request: Request): string {
  const direct = request.headers.get('cf-connecting-ip');
  if (direct !== null && direct !== '') return direct.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  const last = forwarded?.split(',').at(-1)?.trim();
  return last === undefined || last === '' ? 'unknown' : last;
}

export class ReadThrottle {
  private readonly tables: KeyedBuckets;
  private readonly addresses: KeyedBuckets;

  constructor(limits: ReadLimits = DEFAULT_READ_LIMITS) {
    this.tables = new KeyedBuckets(limits.tableBurst, limits.tablePerSecond);
    this.addresses = new KeyedBuckets(limits.addressBurst, limits.addressPerSecond);
  }

  /** Counts a read; a 429 `RATE_LIMITED` with `Retry-After` when the table or the address is over. */
  admit(request: Request, now: number = Date.now()): void {
    const token = request.headers.get(TABLE_TOKEN_HEADER) ?? '';
    const wait = Math.max(
      this.addresses.take(clientAddressOf(request), now),
      token === '' ? 0 : this.tables.take(token, now),
    );
    if (wait === 0) return;
    throw new HttpError(
      429,
      'RATE_LIMITED',
      'Too many requests just now. Please wait a moment.',
      { retryAfterSeconds: wait },
      { 'retry-after': String(wait) },
    );
  }
}

/** One per function instance. */
export const readThrottle = new ReadThrottle();
