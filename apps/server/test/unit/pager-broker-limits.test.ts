import { describe, expect, it } from 'vitest';
import {
  BUSY,
  ConnectionGate,
  MqttPacketSizes,
  TaskLimiter,
  ThrottledLog,
  TokenBucket,
} from '../../src/pagers/broker-limits.js';

/** The pager broker's limits as mechanisms (P8-03b2b, PAGER-D3, PAGER-R3). */

describe('[SEC-012] packet sizes at the header (PAGER-D3)', () => {
  it('passes packets within the limit, whatever the chunks they come in', () => {
    const sizes = new MqttPacketSizes(10);
    // A PINGREQ (2 bytes), a PUBLISH of 10 bytes split over three chunks, another PINGREQ.
    expect(sizes.scan(Buffer.from([0xc0, 0x00, 0x30]))).toBeUndefined();
    expect(sizes.scan(Buffer.from([0x08, 1, 2, 3]))).toBeUndefined();
    expect(sizes.scan(Buffer.from([4, 5, 6, 7, 8, 0xc0, 0x00]))).toBeUndefined();
  });

  it('says so at the header of a packet over the limit, before its body', () => {
    expect(new MqttPacketSizes(10).scan(Buffer.from([0x30, 0x09]))).toBe('a packet of 11 bytes');
    // 268 MB announced in four length bytes, the last arriving alone.
    const sizes = new MqttPacketSizes(1_024);
    expect(sizes.scan(Buffer.from([0x10, 0xff, 0xff, 0xff]))).toBeUndefined();
    expect(sizes.scan(Buffer.from([0x7f]))).toBe('a packet of 268435460 bytes');
  });

  it('refuses a length that runs past four bytes', () => {
    expect(new MqttPacketSizes(1_024).scan(Buffer.from([0x10, 0x80, 0x80, 0x80, 0x80]))).toBe(
      'a malformed packet length',
    );
  });

  it('applies a raised limit from the next packet on', () => {
    const sizes = new MqttPacketSizes(4);
    expect(sizes.scan(Buffer.from([0x10, 0x02, 0, 0]))).toBeUndefined();
    sizes.limit = 100;
    expect(sizes.scan(Buffer.from([0x30, 0x50]))).toBeUndefined();
  });
});

describe('[SEC-012] connections let in (PAGER-D3)', () => {
  const limits = { maxConnections: 4, maxPending: 3, maxPendingPerAddress: 2, trustLoopback: true };

  it('lets a few sign-ins at a time in from one address', () => {
    const gate = new ConnectionGate(limits);
    const first = gate.admit('10.0.0.5');
    expect(gate.admit('10.0.0.5')).toBeDefined();
    expect(gate.admit('10.0.0.5')).toBeUndefined();
    // Signed in, it no longer counts against its address.
    first?.signedIn();
    expect(gate.admit('10.0.0.5')).toBeDefined();
    expect(gate.counts()).toEqual({ open: 3, pending: 2 });
  });

  it('limits sign-ins in progress and connections in all', () => {
    const gate = new ConnectionGate(limits);
    const tickets = ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map((address) => gate.admit(address));
    expect(gate.admit('10.0.0.4')).toBeUndefined();
    tickets[0]?.signedIn();
    const fourth = gate.admit('10.0.0.4');
    fourth?.signedIn();
    // Four open: nobody else, until one closes.
    expect(gate.admit('10.0.0.6')).toBeUndefined();
    fourth?.closed();
    fourth?.closed();
    expect(gate.admit('10.0.0.6')).toBeDefined();
  });

  it('does not limit the PC’s own address per address, when trusted', () => {
    const trusting = new ConnectionGate(limits);
    for (const address of ['127.0.0.1', '127.0.0.1', '::ffff:127.0.0.1']) {
      expect(trusting.admit(address)).toBeDefined();
    }
    const strict = new ConnectionGate({ ...limits, trustLoopback: false });
    strict.admit('127.0.0.1');
    strict.admit('127.0.0.1');
    expect(strict.admit('127.0.0.1')).toBeUndefined();
  });
});

describe('[SEC-012] Argon2id checks at once (PAGER-D3)', () => {
  it('runs a few at once, lets a few wait, and turns the rest away at once', async () => {
    const limiter = new TaskLimiter(1, 1);
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      new Promise<string>((resolve) => {
        running += 1;
        most = Math.max(most, running);
        releases.push(() => {
          running -= 1;
          resolve('checked');
        });
      });
    const first = limiter.run(task);
    const second = limiter.run(task);
    expect(await limiter.run(task)).toBe(BUSY);
    releases.shift()?.();
    expect(await first).toBe('checked');
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    expect(await second).toBe('checked');
    expect(most).toBe(1);
    // The place is free again.
    const third = limiter.run(() => Promise.resolve('again'));
    expect(await third).toBe('again');
  });
});

describe('[SEC-012] refusals in the log (PAGER-R3)', () => {
  it('says each refusal from an address once a period, with the count since the last', () => {
    let now = 0;
    const lines: [string, number][] = [];
    const log = new ThrottledLog(
      60_000,
      (key, count) => {
        lines.push([key, count]);
      },
      () => now,
    );
    log.note('wrong-secret|10.0.0.5|p1');
    log.note('wrong-secret|10.0.0.5|p1');
    log.note('wrong-secret|10.0.0.5|p1');
    log.note('wrong-secret|10.0.0.6|p1');
    now = 60_000;
    log.note('wrong-secret|10.0.0.5|p1');
    expect(lines).toEqual([
      ['wrong-secret|10.0.0.5|p1', 1],
      ['wrong-secret|10.0.0.6|p1', 1],
      ['wrong-secret|10.0.0.5|p1', 3],
    ]);
  });
});

describe('[SEC-012] acknowledgements a pager may send (PAGER-D4)', () => {
  it('takes a burst, then one each period, and never saves up more than the burst', () => {
    const bucket = new TokenBucket(3, 1_000, 0);
    expect([1, 2, 3, 4].map(() => bucket.take(0))).toEqual([true, true, true, false]);
    expect(bucket.take(999)).toBe(false);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(1_500)).toBe(false);
    // An hour idle gives back the burst, not 3,600.
    expect(Array.from({ length: 4 }, () => bucket.take(3_600_000))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
