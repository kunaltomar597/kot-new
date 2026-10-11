/**
 * Plain mechanisms against flooding, shared by the pager broker (PAGER-D3, PAGER-D4, P8-03b2b) and
 * the HTTPS server with its socket (PC-D3, P8-03c2a): connections counted per address, token
 * buckets, and a log that says each kind of refusal once a period.
 */

/** The PC's own addresses: the POS window, the set-up checks, the load test (IPv4 and IPv6). */
export function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/** A connection's place in the gate's count, released when it signs in and when it closes. */
export interface GateTicket {
  /** The connection signed in: it no longer counts as a sign-in in progress. */
  signedIn(): void;
  /** The connection closed. */
  closed(): void;
}

export interface GateLimits {
  /** Connections at once, signed in or not. */
  readonly maxConnections: number;
  /** Connections not signed in yet, in all. */
  readonly maxPending: number;
  /** Connections not signed in yet from one address. */
  readonly maxPendingPerAddress: number;
  /** The PC's own addresses are not limited per address (the load test, the set-up checks). */
  readonly trustLoopback: boolean;
}

/**
 * Admits connections up to the limits (PAGER-D3). Each pager has one session, so signed-in
 * connections are as many as the pagers; what a host on the LAN can open without a credential is
 * a few connections at a time, each for the sign-in time. A connection that never signs in (an
 * HTTPS connection: each request proves its device itself) counts as pending while it is open.
 */
export class ConnectionGate {
  private open = 0;
  private pending = 0;
  private readonly pendingBy = new Map<string, number>();

  constructor(private readonly limits: GateLimits) {}

  /** A ticket for a new connection from the address, or undefined when it must be refused. */
  admit(address: string | undefined): GateTicket | undefined {
    const from = address ?? 'unknown';
    const byAddress = this.pendingBy.get(from) ?? 0;
    if (this.open >= this.limits.maxConnections || this.pending >= this.limits.maxPending) {
      return undefined;
    }
    const limited = !(this.limits.trustLoopback && isLoopback(from));
    if (limited && byAddress >= this.limits.maxPendingPerAddress) return undefined;
    this.open += 1;
    this.pending += 1;
    this.pendingBy.set(from, byAddress + 1);
    let state: 'PENDING' | 'SIGNED_IN' | 'CLOSED' = 'PENDING';
    const release = () => {
      this.pending -= 1;
      const left = (this.pendingBy.get(from) ?? 1) - 1;
      if (left <= 0) this.pendingBy.delete(from);
      else this.pendingBy.set(from, left);
    };
    return {
      signedIn: () => {
        if (state !== 'PENDING') return;
        state = 'SIGNED_IN';
        release();
      },
      closed: () => {
        if (state === 'CLOSED') return;
        if (state === 'PENDING') release();
        state = 'CLOSED';
        this.open -= 1;
      },
    };
  }

  /** Connections open now, and how many of them have not signed in. */
  counts(): { open: number; pending: number } {
    return { open: this.open, pending: this.pending };
  }
}

/** Takes up to `burst` at once, then one each `everyMs` (PAGER-D4). */
export class TokenBucket {
  private tokens: number;

  constructor(
    private readonly burst: number,
    private readonly everyMs: number,
    private lastMs: number,
  ) {
    this.tokens = burst;
  }

  take(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens === 0) return false;
    this.tokens -= 1;
    return true;
  }

  /** Whether the bucket has filled up again: it remembers nothing worth keeping. */
  full(nowMs: number): boolean {
    this.refill(nowMs);
    return this.tokens === this.burst;
  }

  private refill(nowMs: number): void {
    const earned = Math.floor((nowMs - this.lastMs) / this.everyMs);
    if (earned > 0) {
      this.tokens = Math.min(this.burst, this.tokens + earned);
      this.lastMs += earned * this.everyMs;
    }
  }
}

/** A rate: `burst` at once, then `perSecond`. */
export interface Rate {
  readonly burst: number;
  readonly perSecond: number;
}

/**
 * A token bucket per key, an address say (PC-D3). Keys whose bucket has filled up again are
 * forgotten once there are many, so a host that cycles through keys cannot grow the map without
 * end.
 */
export class KeyedBuckets {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly everyMs: number;

  constructor(
    private readonly rate: Rate,
    private readonly maxKeys = 10_000,
  ) {
    this.everyMs = 1_000 / rate.perSecond;
  }

  take(key: string, nowMs: number): boolean {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.forgetFull(nowMs);
      bucket = new TokenBucket(this.rate.burst, this.everyMs, nowMs);
      this.buckets.set(key, bucket);
    }
    return bucket.take(nowMs);
  }

  /** Keys remembered now. */
  get size(): number {
    return this.buckets.size;
  }

  private forgetFull(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.full(nowMs)) this.buckets.delete(key);
    }
  }
}

/**
 * Says each kind of refusal from an address at most once a period, with how many there were
 * since, so a flood is visible in the log without filling it (PAGER-R3).
 */
export class ThrottledLog {
  private readonly last = new Map<string, { at: number; since: number }>();

  constructor(
    private readonly periodMs: number,
    private readonly write: (key: string, count: number) => void,
    private readonly now: () => number,
  ) {}

  note(key: string): void {
    const now = this.now();
    const entry = this.last.get(key);
    if (entry !== undefined && now - entry.at < this.periodMs) {
      entry.since += 1;
      return;
    }
    this.write(key, (entry?.since ?? 0) + 1);
    this.last.set(key, { at: now, since: 0 });
    if (this.last.size > 1_000) {
      for (const [old, value] of this.last) {
        if (now - value.at >= this.periodMs) this.last.delete(old);
      }
    }
  }
}
