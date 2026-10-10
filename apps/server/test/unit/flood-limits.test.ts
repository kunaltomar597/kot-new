import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyedBuckets, TokenBucket } from '../../src/common/flood-limits.js';
import {
  DEFAULT_SERVER_LIMITS,
  limitFloods,
  type RefusalWriter,
  type ServerLimits,
} from '../../src/http/flood-limits.js';

/** The HTTPS server's limits as mechanisms (P8-03c2a, PC-D3), on a plain HTTP server. */

describe('[SEC-009] token buckets per key (PC-D3)', () => {
  it('takes a burst, then the rate, per key', () => {
    const buckets = new KeyedBuckets({ burst: 3, perSecond: 2 });
    for (let taken = 0; taken < 3; taken += 1) expect(buckets.take('10.0.0.5', 0)).toBe(true);
    expect(buckets.take('10.0.0.5', 0)).toBe(false);
    // Another address has its own bucket.
    expect(buckets.take('10.0.0.6', 0)).toBe(true);
    // Two a second: one more after half a second, none saved up beyond the burst.
    expect(buckets.take('10.0.0.5', 499)).toBe(false);
    expect(buckets.take('10.0.0.5', 500)).toBe(true);
    expect(buckets.take('10.0.0.5', 500)).toBe(false);
    for (let taken = 0; taken < 3; taken += 1) expect(buckets.take('10.0.0.5', 60_000)).toBe(true);
    expect(buckets.take('10.0.0.5', 60_000)).toBe(false);
  });

  it('forgets keys whose bucket filled up again, once there are many', () => {
    const buckets = new KeyedBuckets({ burst: 2, perSecond: 1 }, 3);
    buckets.take('a', 0);
    buckets.take('b', 0);
    buckets.take('c', 1_500);
    // At 2 s, a and b are full again; c is not: a new key makes room by forgetting a and b.
    buckets.take('d', 2_000);
    expect(buckets.size).toBe(2);
    // c is remembered as it was: one token used, one earned back at 2.5 s.
    expect(buckets.take('c', 2_000)).toBe(true);
    expect(buckets.take('c', 2_000)).toBe(false);
  });

  it('says when a bucket is full again', () => {
    const bucket = new TokenBucket(2, 100, 0);
    bucket.take(0);
    expect(bucket.full(99)).toBe(false);
    expect(bucket.full(100)).toBe(true);
  });
});

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe('[SEC-009] [SEC-017] the server’s limits per address (PC-D3)', () => {
  let server: Server | undefined;
  const sockets: Socket[] = [];
  let clock = 0;
  const logged: Parameters<RefusalWriter>[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    logged.length = 0;
    clock = 0;
    await new Promise<void>((resolve) => {
      if (server === undefined) resolve();
      else
        server.close(() => {
          resolve();
        });
    });
    server = undefined;
  });

  async function serve(limits: Partial<ServerLimits>): Promise<number> {
    const app = express();
    const created = createServer(app);
    app.use(
      limitFloods(
        created,
        { ...DEFAULT_SERVER_LIMITS, trustLoopback: false, ...limits },
        (...entry) => logged.push(entry),
        () => clock,
      ),
    );
    app.get('/ok', (_request, response) => {
      response.json({ ok: true });
    });
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
    server = created;
    const address = created.address();
    if (address === null || typeof address === 'string') throw new Error('Not listening');
    return address.port;
  }

  /** A connection that stays open; resolves with whether the server kept it. */
  function open(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      sockets.push(socket);
      let settled = false;
      const settle = (kept: boolean) => {
        if (settled) return;
        settled = true;
        resolve(kept);
      };
      socket.on('close', () => {
        settle(false);
      });
      socket.on('error', () => {
        settle(false);
      });
      // A connection the gate refused is closed at once; one it took stays open.
      socket.on('connect', () =>
        setTimeout(() => {
          settle(!socket.destroyed);
        }, 100),
      );
    });
  }

  function get(port: number, path = '/ok'): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, path }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  it('closes an address’s connections over its limit before reading anything', async () => {
    const port = await serve({ maxConnectionsPerAddress: 3 });
    expect(await Promise.all([open(port), open(port), open(port)])).toEqual([true, true, true]);
    expect(await open(port)).toBe(false);
    // One closes: its place is free again.
    sockets[0]?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await open(port)).toBe(true);
    expect(logged.map(([, fields]) => fields.reason)).toEqual(['too-many-connections']);
  });

  it('closes connections an address opens faster than the rate', async () => {
    const port = await serve({ connectionsPerAddress: { burst: 3, perSecond: 1 } });
    for (let opened = 0; opened < 3; opened += 1) expect(await open(port)).toBe(true);
    expect(await open(port)).toBe(false);
    clock += 1_000;
    expect(await open(port)).toBe(true);
  });

  it('answers 429 to requests over the rate, closing the connection', async () => {
    const port = await serve({ requestsPerAddress: { burst: 2, perSecond: 1 } });
    expect((await get(port)).status).toBe(200);
    expect((await get(port)).status).toBe(200);
    const refused = await get(port);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.headers.connection).toBe('close');
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'RATE_LIMITED' });
    clock += 1_000;
    expect((await get(port)).status).toBe(200);
  });

  it('logs each kind of refusal from an address once a minute, with the count', async () => {
    const port = await serve({ requestsPerAddress: { burst: 1, perSecond: 1 } });
    await get(port);
    for (let sent = 0; sent < 3; sent += 1) await get(port);
    expect(logged).toEqual([
      [
        'Refused requests from an address sending them too fast',
        { reason: 'requests-too-fast', address: '127.0.0.1', count: 1 },
      ],
    ]);
    clock += 60_000;
    await get(port);
    expect(logged).toHaveLength(1);
    await get(port);
    expect(logged[1]?.[1]).toEqual({
      reason: 'requests-too-fast',
      address: '127.0.0.1',
      count: 3,
    });
  });

  it('never limits the PC’s own address when it is trusted', async () => {
    const port = await serve({
      trustLoopback: true,
      maxConnectionsPerAddress: 1,
      connectionsPerAddress: { burst: 1, perSecond: 1 },
      requestsPerAddress: { burst: 1, perSecond: 1 },
    });
    expect(await Promise.all([open(port), open(port), open(port)])).toEqual([true, true, true]);
    for (let sent = 0; sent < 3; sent += 1) expect((await get(port)).status).toBe(200);
    expect(logged).toEqual([]);
  });

  it('sets Node’s timers for headers, whole requests and idle connections', async () => {
    await serve({ headersMs: 1_234, requestMs: 5_678, keepAliveMs: 910 });
    expect(server?.headersTimeout).toBe(1_234);
    expect(server?.requestTimeout).toBe(5_678);
    expect(server?.keepAliveTimeout).toBe(910);
  });
});
