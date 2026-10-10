import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { GateTicket } from '../common/flood-limits.js';

// Shared with the HTTPS server's limits (P8-03c2a); imported from here by the broker and its tests.
export {
  ConnectionGate,
  type GateLimits,
  type GateTicket,
  ThrottledLog,
  TokenBucket,
} from '../common/flood-limits.js';

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
