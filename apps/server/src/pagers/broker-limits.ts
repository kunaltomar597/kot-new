import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

/**
 * The pager broker's defences against flooding (PAGER-D3, PAGER-D4, P8-03b2b). The broker runs in
 * the POS server's process, so anyone on the staff network must not be able to make it read huge
 * packets, hold many connections or hash passwords without end. Plain mechanisms here; the broker
 * applies them.
 */

/**
 * Follows the MQTT fixed headers in a byte stream (MQTT 3.1.1 §2.2): a type byte, the remaining
 * length in one to four bytes of seven bits each, then that many bytes. It says when a packet
 * announces more than the limit, before its body has arrived, so nothing ever buffers it.
 */
export class MqttPacketSizes {
  private phase: 'TYPE' | 'LENGTH' | 'BODY' = 'TYPE';
  private length = 0;
  private lengthBytes = 0;
  private left = 0;

  constructor(
    /** The largest packet taken, in bytes with its fixed header. */
    public limit: number,
  ) {}

  /** Why the stream must end, or undefined while every packet is within the limit. */
  scan(chunk: Buffer): string | undefined {
    let index = 0;
    while (index < chunk.length) {
      if (this.phase === 'BODY') {
        const taken = Math.min(this.left, chunk.length - index);
        this.left -= taken;
        index += taken;
        if (this.left === 0) this.phase = 'TYPE';
        continue;
      }
      const byte = chunk[index] ?? 0;
      index += 1;
      if (this.phase === 'TYPE') {
        this.phase = 'LENGTH';
        this.length = 0;
        this.lengthBytes = 0;
        continue;
      }
      this.length += (byte & 0x7f) * 128 ** this.lengthBytes;
      this.lengthBytes += 1;
      if ((byte & 0x80) !== 0) {
        if (this.lengthBytes === 4) return 'a malformed packet length';
        continue;
      }
      const size = 1 + this.lengthBytes + this.length;
      if (size > this.limit) return `a packet of ${String(size)} bytes`;
      this.left = this.length;
      this.phase = this.left === 0 ? 'TYPE' : 'BODY';
    }
    return undefined;
  }
}

/** A connection's place in the broker's count, released when it signs in and when it closes. */
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

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * Admits connections up to the limits (PAGER-D3). Each pager has one session, so signed-in
 * connections are as many as the pagers; what a host on the LAN can open without a credential is
 * a few connections at a time, each for the sign-in time.
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

/**
 * The broker's side of one connection: the socket's bytes pass through unchanged while every
 * packet is within the limit, which is small until the pager signs in. A larger packet ends the
 * connection at its header (PAGER-D3, PAGER-D4).
 */
export class LimitedConnection extends Duplex {
  private readonly sizes: MqttPacketSizes;

  constructor(
    private readonly socket: Socket,
    limit: number,
    private readonly ticket: GateTicket | undefined,
    onTooLarge: (problem: string) => void,
  ) {
    super({ allowHalfOpen: false });
    this.sizes = new MqttPacketSizes(limit);
    socket.on('data', (chunk: Buffer) => {
      const problem = this.sizes.scan(chunk);
      if (problem !== undefined) {
        onTooLarge(problem);
        this.destroy();
        return;
      }
      if (!this.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      this.push(null);
    });
    socket.on('error', (error) => {
      this.destroy(error);
    });
    socket.on('close', () => {
      this.destroy();
    });
  }

  /** The pager signed in: its packets may be as large as `limit` from now on. */
  signedIn(limit: number): void {
    this.sizes.limit = limit;
    this.ticket?.signedIn();
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.socket.write(chunk, encoding)) callback();
    else
      this.socket.once('drain', () => {
        callback();
      });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy();
    callback(error);
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
    const earned = Math.floor((nowMs - this.lastMs) / this.everyMs);
    if (earned > 0) {
      this.tokens = Math.min(this.burst, this.tokens + earned);
      this.lastMs += earned * this.everyMs;
    }
    if (this.tokens === 0) return false;
    this.tokens -= 1;
    return true;
  }
}

export const BUSY = Symbol('BUSY');

/**
 * Runs at most `concurrency` tasks at once and lets at most `maxWaiting` wait; beyond that a task
 * is not run at all (PAGER-D3: each Argon2id check takes 19 MiB and tens of milliseconds, so a
 * flood of sign-ins must not run them all at once).
 */
export class TaskLimiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T | typeof BUSY> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) return BUSY;
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // The place passes to the next task waiting, or is given back.
      if (next === undefined) this.running -= 1;
      else next();
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
