import type { IncomingHttpHeaders } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Worker } from 'node:worker_threads';
import type { INestApplication } from '@nestjs/common';
import { REALTIME_CONNECT_ERRORS } from '@rp/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServerLimits } from '../../src/http/flood-limits.js';
import {
  DEFAULT_REALTIME_OPTIONS,
  REALTIME_OPTIONS,
  RealtimeGateway,
  type RealtimeOptions,
} from '../../src/realtime/realtime.gateway.js';
import { TlsService } from '../../src/tls/tls.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
} from '../helpers/auth-kit.js';
import { domainEvent, produce } from '../helpers/events.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * P8-03c2a acceptance (PC-D3): the local server under floods from the LAN, over HTTPS as in
 * production. Two addresses of this machine stand for two hosts on the staff network, an attacker
 * at 127.0.0.1 and a device at ::1, with the server listening on both and the PC's own address not
 * trusted. Most limits are made small so a flood is short; the last flood runs against the
 * production limits.
 */

const ATTACKER = '127.0.0.1';
const DEVICE = '::1';

let database: TestDatabase;
let app: INestApplication | undefined;
let port: number;
let ca: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

afterAll(async () => {
  await database.drop();
});

/** Starts the server over HTTPS on both addresses with these limits. */
async function start(
  limits: Partial<ServerLimits> = {},
  realtime?: RealtimeOptions,
  tls = true,
): Promise<INestApplication> {
  const started = await createTestApp({
    databaseUrl: database.url,
    host: '::',
    config: { tls },
    serverLimits: { trustLoopback: false, ...limits },
    ...(realtime !== undefined && {
      overrides: [{ provide: REALTIME_OPTIONS, useValue: realtime }],
    }),
  });
  port = Number(new URL(appUrl(started)).port);
  ca = started.get(TlsService).ca()?.certificate ?? '';
  app = started;
  return started;
}

async function stop(): Promise<void> {
  await app?.close();
  app = undefined;
}

/** The certificate names `localhost` and 127.0.0.1, not ::1: it is checked for `localhost`. */
const tlsTo = (host: string) => ({ host, port, ca, servername: 'localhost' });

/** A TCP connection from `host`, resolved once connected. */
function tcp(host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    sockets.push(socket);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.on('error', () => undefined);
      resolve(socket);
    });
  });
}

/** A TLS connection from `host`, resolved once its handshake is done. */
function secure(host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(tlsTo(host), () => {
      socket.on('error', () => undefined);
      resolve(socket);
    });
    sockets.push(socket);
    socket.once('error', reject);
    socket.once('close', () => {
      reject(new Error('Closed before the handshake was done'));
    });
  });
}

/** How long from now until the server closes the connection (the client reads what comes). */
function closedAfter(socket: Socket, timeoutMs = 5_000): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The server kept the connection open'));
    }, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
    socket.resume();
  });
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
}

/** A GET from `host`; status 0 when the server closed the connection instead of answering. */
function get(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  agent: Agent | false = false,
): Promise<Answer> {
  return new Promise((resolve) => {
    const outgoing = httpsRequest({ ...tlsTo(host), path, headers, agent }, (response) => {
      response.resume();
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      });
    });
    outgoing.on('error', () => {
      resolve({ status: 0, headers: {} });
    });
    outgoing.end();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('[SEC-017] connections that send nothing more are closed (PC-D3)', () => {
  beforeAll(async () => {
    await start({ handshakeMs: 500, headersMs: 500, checkEveryMs: 100, keepAliveMs: 300 });
  });

  afterAll(stop);

  it('closes a connection that never finishes its TLS handshake', async () => {
    const after = await closedAfter(await tcp(ATTACKER));
    expect(after).toBeGreaterThan(400);
    expect(after).toBeLessThan(3_000);
  });

  it('closes a connection whose request headers trickle in (Slowloris)', async () => {
    const socket = await secure(ATTACKER);
    socket.write('GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n');
    let line = 0;
    // A header line every 100 ms, never the blank line that ends them.
    const trickle = setInterval(() => {
      line += 1;
      if (!socket.destroyed) socket.write(`X-Slow-${String(line)}: 1\r\n`);
    }, 100);
    try {
      expect(await closedAfter(socket)).toBeLessThan(3_000);
    } finally {
      clearInterval(trickle);
    }
  });

  it('closes a connection left idle after its answer', async () => {
    const socket = await secure(ATTACKER);
    let answer = '';
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
    });
    socket.write('GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n');
    expect(await closedAfter(socket)).toBeLessThan(3_000);
    expect(answer).toMatch(/^HTTP\/1\.1 200 /);
  });
});

describe('[SEC-009] [SEC-017] each address is held to its share (PC-D3)', () => {
  afterEach(stop);

  it('holds an address to its open connections, while another address is served', async () => {
    await start({ maxConnectionsPerAddress: 8 });
    const held = await Promise.all(Array.from({ length: 8 }, () => secure(ATTACKER)));
    await expect(secure(ATTACKER)).rejects.toThrow();
    expect((await get(DEVICE, '/api/v1/health')).status).toBe(200);
    // One closes: its place is free again.
    const first = held[0];
    first?.destroy();
    if (first !== undefined) await until(() => first.closed, 2_000, 'the connection to close');
    await sleep(50);
    await expect(secure(ATTACKER)).resolves.toBeDefined();
  });

  it('stops at once while a host holds connections that never send a request', async () => {
    await start();
    await Promise.all(Array.from({ length: 4 }, () => secure(ATTACKER)));
    const stopping = performance.now();
    await stop();
    expect(performance.now() - stopping).toBeLessThan(5_000);
  });

  it('closes connections an address opens too fast, before their handshake', async () => {
    await start({ connectionsPerAddress: { burst: 10, perSecond: 1 } });
    let refused = 0;
    for (let opened = 0; opened < 30; opened += 1) {
      try {
        (await secure(ATTACKER)).destroy();
      } catch {
        refused += 1;
      }
    }
    // Ten at once, one a second after them.
    expect(refused).toBeGreaterThanOrEqual(10);
    expect((await get(DEVICE, '/api/v1/health')).status).toBe(200);
  });

  it('answers 429 to an address sending requests too fast, and closes its connection', async () => {
    await start({ requestsPerAddress: { burst: 10, perSecond: 1 } });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const answers: Answer[] = [];
      for (let sent = 0; sent < 30; sent += 1) {
        answers.push(await get(ATTACKER, '/api/v1/health', {}, agent));
      }
      const limited = answers.filter((answer) => answer.status === 429);
      expect(limited.length).toBeGreaterThanOrEqual(10);
      expect(limited[0]?.headers['retry-after']).toBe('1');
      expect(limited[0]?.headers.connection).toBe('close');
      expect((await get(DEVICE, '/api/v1/health')).status).toBe(200);
    } finally {
      agent.destroy();
    }
  });
});

/** What a flooding host did: requests sent, answered 429, and refused at the connection. */
interface FloodReport {
  readonly sent: number;
  readonly limited: number;
  readonly refused: number;
}

/**
 * A host flooding the server from `host` for `forMs`, in a thread of its own (its own work must
 * not slow the server's thread): half its lanes open a new connection for each request, half send
 * request after request on kept-alive connections.
 */
function flood(host: string, forMs: number, lanes = 50): Promise<FloodReport> {
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const https = require('node:https');
    const { host, port, ca, forMs, lanes } = workerData;
    const until = Date.now() + forMs;
    const kept = new https.Agent({ keepAlive: true, maxSockets: Math.ceil(lanes / 2) });
    const report = { sent: 0, limited: 0, refused: 0 };
    const once = (agent) =>
      new Promise((resolve) => {
        report.sent += 1;
        const outgoing = https.request(
          { host, port, ca, servername: 'localhost', path: '/api/v1/health', agent },
          (response) => {
            if (response.statusCode === 429) report.limited += 1;
            response.resume();
            response.on('end', resolve);
            response.on('error', resolve);
          },
        );
        outgoing.on('error', () => {
          report.refused += 1;
          resolve();
        });
        outgoing.end();
      });
    const lane = async (index) => {
      while (Date.now() < until) await once(index % 2 === 0 ? false : kept);
    };
    Promise.all(Array.from({ length: lanes }, (_, index) => lane(index))).then(() => {
      kept.destroy();
      parentPort.postMessage(report);
    });
    `,
    { eval: true, workerData: { host, port, ca, forMs, lanes } },
  );
  return new Promise((resolve, reject) => {
    worker.once('message', (report: FloodReport) => {
      resolve(report);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

describe('[SEC-009] [SEC-017] [NFR-P01] a flood from one host leaves the others served (PC-D3)', () => {
  let server: INestApplication;
  let kit: AuthKit;
  let device: string;
  let screen: RealtimeTestClient | undefined;

  beforeAll(async () => {
    // The production limits, with the PC's own address treated as another host's.
    server = await start();
    kit = await createAuthKit(server);
    device = await addDevice(server, kit, 'POS');
  });

  afterAll(async () => {
    screen?.close();
    await stop();
  });

  it('keeps another device’s screen live and its requests answered within a second', async () => {
    screen = await RealtimeTestClient.connect(
      `https://[${DEVICE}]:${String(port)}`,
      { deviceToken: deviceTokenOf(device) },
      {
        ca,
        checkServerIdentity: (_host, certificate) => checkServerIdentity('localhost', certificate),
      },
    );
    const flooding = flood(ATTACKER, 3_000);
    await sleep(1_000);

    // An event the screen must show (NFR-P01: on the screen within a second).
    const event = domainEvent('MenuPublished', kit.restaurantId, { menuVersion: 7 });
    const sentAt = performance.now();
    await produce(server, [event]);
    await screen.waitForEvent(event.eventId, 1_000);
    const eventMs = performance.now() - sentAt;

    const askedAt = performance.now();
    const answer = await get(DEVICE, '/api/v1/version', authHeaders(device));
    const answerMs = performance.now() - askedAt;

    const report = await flooding;
    expect(eventMs).toBeLessThan(1_000);
    expect(answer.status).toBe(200);
    expect(answerMs).toBeLessThan(1_000);
    // The attacker was held back, at the connection and by request.
    expect(report.limited).toBeGreaterThan(0);
    expect(report.refused).toBeGreaterThan(0);
    expect(screen.disconnectReason).toBeUndefined();
  });
});

describe('[SEC-009] [SEC-017] a device’s live connections (PC-D3)', () => {
  const OPTIONS: RealtimeOptions = {
    ...DEFAULT_REALTIME_OPTIONS,
    sweepIntervalMs: 200,
    maxConnectionsPerDevice: 3,
    handshakesPerMinutePerDevice: 6,
    maxUnsentPerConnection: 50,
    // Long, so only the limit under test closes a connection that stops reading.
    pingIntervalMs: 60_000,
    pingTimeoutMs: 60_000,
  };
  let server: INestApplication;
  let kit: AuthKit;
  let url: string;
  const clients: RealtimeTestClient[] = [];

  beforeAll(async () => {
    // Plain HTTP on the PC's own address: these limits are per device, not per address.
    server = await start({ trustLoopback: true }, OPTIONS, false);
    kit = await createAuthKit(server);
    url = appUrl(server);
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(stop);

  async function connect(deviceId: string): Promise<RealtimeTestClient> {
    const client = await RealtimeTestClient.connect(url, { deviceToken: deviceTokenOf(deviceId) });
    clients.push(client);
    return client;
  }

  const connected = (deviceId: string) =>
    server.get(RealtimeGateway).connectedDeviceIds(kit.restaurantId).has(deviceId);

  /** The client's TCP connection, to read from it at another pace than Socket.io's. */
  function rawSocketOf(client: RealtimeTestClient): Socket {
    const { transport } = client.socket.io.engine as unknown as {
      transport: { ws?: { _socket?: Socket } };
    };
    const raw = transport.ws?._socket;
    if (raw === undefined) throw new Error('The client has no WebSocket to pause');
    return raw;
  }

  /** Events of about 40 kB each, so a few hundred are more than the operating system holds. */
  function bigEvents(count: number): ReturnType<typeof domainEvent>[] {
    const keys = Array.from(
      { length: 500 },
      (_, index) => `flood.${String(index).padStart(70, '0')}`,
    );
    return Array.from({ length: count }, () =>
      domainEvent('SettingsChanged', kit.restaurantId, { keys }),
    );
  }

  const gotAll = (client: RealtimeTestClient, events: ReturnType<typeof domainEvent>[]) =>
    events.every((event) =>
      client.events.some((message) => message.event.eventId === event.eventId),
    );

  it('refuses a device’s connections over its limit, and no other device’s', async () => {
    const tablet = await addDevice(server, kit, 'POS');
    const first = await connect(tablet);
    await connect(tablet);
    await connect(tablet);
    expect(
      (await RealtimeTestClient.refused(url, { deviceToken: deviceTokenOf(tablet) })).code,
    ).toBe(REALTIME_CONNECT_ERRORS.tooManyConnections);
    await connect(await addDevice(server, kit, 'POS'));
    // One closes: once the server has seen it go, the device may connect again.
    first.close();
    await until(
      () =>
        connect(tablet).then(
          () => true,
          () => false,
        ),
      3_000,
      'a place for the device again',
    );
  });

  it('refuses a device that opens connections too fast, and no other device', async () => {
    const pos = await addDevice(server, kit, 'POS');
    for (let opened = 0; opened < 6; opened += 1) {
      const client = await connect(pos);
      client.close();
      await until(() => !connected(pos), 2_000, 'the connection to close');
    }
    expect((await RealtimeTestClient.refused(url, { deviceToken: deviceTokenOf(pos) })).code).toBe(
      REALTIME_CONNECT_ERRORS.tooManyConnections,
    );
    await expect(connect(await addDevice(server, kit, 'POS'))).resolves.toBeDefined();
  });

  it('cuts off a connection that stops reading, while others get every event', async () => {
    const stalled = await addDevice(server, kit, 'POS');
    const reader = await connect(await addDevice(server, kit, 'POS'));
    const quiet = await connect(stalled);
    // The app stops reading but stays connected (a device that still answered pings would too).
    rawSocketOf(quiet).pause();

    // 300 events of about 40 kB: more than the operating system holds for a connection.
    const events = bigEvents(300);
    await produce(server, events);

    await until(() => !connected(stalled), 10_000, 'the stalled connection to be cut off');
    await reader.waitFor(() => gotAll(reader, events), 10_000);
    expect(reader.disconnectReason).toBeUndefined();
  });

  it('keeps a connection that reads slowly, however long a flush takes to go out', async () => {
    const reader = await connect(await addDevice(server, kit, 'POS'));
    // About 512 kB every 100 ms: a tablet on weak Wi-Fi, or this PC busy with other work. The
    // first flush of 100 events (4 MB) takes it most of a second, several sweeps, while the next
    // 100 wait for it, over the limit.
    const raw = rawSocketOf(reader);
    let read = 0;
    raw.on('data', (chunk: Buffer) => {
      read += chunk.length;
      if (read >= 512 * 1024) raw.pause();
    });
    const pace = setInterval(() => {
      read = 0;
      raw.resume();
    }, 100);
    try {
      const first = bigEvents(100);
      const second = bigEvents(100);
      await produce(server, first);
      await produce(server, second);

      await reader.waitFor(() => gotAll(reader, [...first, ...second]), 10_000);
      expect(reader.disconnectReason).toBeUndefined();
    } finally {
      clearInterval(pace);
    }
  });
});
