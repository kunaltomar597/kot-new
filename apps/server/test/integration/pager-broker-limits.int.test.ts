import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { INestApplication } from '@nestjs/common';
import { type LoginResponse, PagerCredentialResponse } from '@rp/contracts';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { PAGER_OPTIONS, PagerBroker } from '../../src/pagers/pager-broker.js';
import { TlsService } from '../../src/tls/tls.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { api, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The pager broker's limits against flooding (P8-03b2b, PAGER-D3, PAGER-D4), over MQTTS as in a
 * restaurant, with limits small enough to reach: one second to sign in, three sign-ins in progress
 * per address (the PC's own address not trusted here), one Argon2id check at a time and one
 * waiting.
 */

const SIGN_IN_MS = 1_000;

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let port: number;
let ca: string;
let pager: PagerCredentialResponse;
const sockets: (Socket | TLSSocket)[] = [];
const clients: MqttClient[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { tls: true, mqtt: 'on', mqttPort: 0, host: '127.0.0.1' },
    overrides: [
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      {
        provide: PAGER_OPTIONS,
        useValue: {
          offlineCheckMs: 0,
          signInMs: SIGN_IN_MS,
          maxPendingPerAddress: 3,
          trustLoopback: false,
          maxChecksAtOnce: 1,
          maxChecksWaiting: 1,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  port = app.get(PagerBroker).port() ?? 0;
  const published = app.get(TlsService).ca();
  if (published === undefined) throw new Error('TLS is not enabled');
  ca = published.certificate;
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  const response = await api(app)
    .post('/api/v1/pagers')
    .set(authHeaders(kit.deviceId, manager.accessToken))
    .send({ serial: 'LIM-0001', name: 'Pager LIM-0001', staffId: null });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  pager = PagerCredentialResponse.parse(response.body);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(clients.splice(0).map((client) => client.endAsync(true)));
  // Every connection of a test is gone before the next one counts its own.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

/** A TCP connection to the broker that never starts TLS. */
function tcp(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => {
      resolve(socket);
    });
    socket.on('error', reject);
    sockets.push(socket);
  });
}

/** A TLS connection to the broker with the CA pinned, as a pager makes before its CONNECT. */
function secure(): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca }, () => {
      resolve(socket);
    });
    socket.on('error', reject);
    sockets.push(socket);
  });
}

/** How long after now the server closed the socket; fails when it is still open after `ms`. */
function closedWithin(socket: Socket, ms: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`still open after ${String(ms)} ms`));
    }, ms);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
  });
}

async function connectPager(
  credential: PagerCredentialResponse,
  options: IClientOptions = {},
): Promise<MqttClient> {
  const client = await mqtt.connectAsync(`mqtts://127.0.0.1:${String(port)}`, {
    clientId: credential.deviceId,
    username: credential.mqttUsername,
    password: credential.mqttPassword,
    ca,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 5_000,
    ...options,
  });
  clients.push(client);
  return client;
}

function closed(client: MqttClient): Promise<void> {
  return new Promise((resolve) => {
    if (!client.connected) {
      resolve();
      return;
    }
    client.once('close', () => {
      resolve();
    });
  });
}

describe('[SEC-012] [SEC-000] before sign-in (PAGER-D3)', () => {
  it('ends a connection whose packet announces more than a CONNECT can be, at its header', async () => {
    const socket = await secure();
    // A CONNECT announcing 268 MB: the broker reads nothing more of it.
    socket.write(Buffer.from([0x10, 0xff, 0xff, 0xff, 0x7f]));
    expect(await closedWithin(socket, SIGN_IN_MS / 2)).toBeLessThan(SIGN_IN_MS / 2);
  });

  it('gives a connection the sign-in time for its TLS handshake and its CONNECT', async () => {
    const silentTcp = await tcp();
    const silentTls = await secure();
    const [tcpAfter, tlsAfter] = await Promise.all([
      closedWithin(silentTcp, SIGN_IN_MS * 3),
      closedWithin(silentTls, SIGN_IN_MS * 3),
    ]);
    expect(tcpAfter).toBeGreaterThan(SIGN_IN_MS * 0.8);
    expect(tlsAfter).toBeGreaterThan(SIGN_IN_MS * 0.8);
  });

  it('takes a few sign-ins at a time from one address, and the pager once they end', async () => {
    const waiting = await Promise.all([tcp(), tcp(), tcp()]);
    // The fourth is refused at once, before its TLS handshake.
    const fourth = await tcp();
    expect(await closedWithin(fourth, SIGN_IN_MS / 2)).toBeLessThan(SIGN_IN_MS / 2);
    await expect(connectPager(pager, { connectTimeout: SIGN_IN_MS / 2 })).rejects.toThrow();
    // The three give up after the sign-in time; then the pager signs in.
    await Promise.all(waiting.map((socket) => closedWithin(socket, SIGN_IN_MS * 3)));
    const client = await connectPager(pager);
    expect(client.connected).toBe(true);
  });

  it('checks one secret at a time with one waiting, and asks the rest to come back', async () => {
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map((attempt) => connectPager(pager, { password: `wrong-${String(attempt)}` })),
    );
    const reasons = outcomes.map((outcome) =>
      outcome.status === 'rejected' ? String(outcome.reason) : 'connected',
    );
    expect(reasons.filter((reason) => reason.includes('Server unavailable'))).toHaveLength(1);
    expect(reasons.filter((reason) => reason.includes('Not authorized'))).toHaveLength(2);
    // Only the secrets checked count as failed sign-ins (PAGER-R3).
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: pager.deviceId } });
    expect(stored.mqttSignInFailures).toBe(2);
  });

  it('refuses a will message, and a name that is no pager without checking a secret', async () => {
    await expect(
      connectPager(pager, { will: { topic: pager.ackTopic, payload: Buffer.from('{}'), qos: 1 } }),
    ).rejects.toThrow();
    const stranger = randomUUID();
    await expect(
      connectPager({ ...pager, deviceId: stranger, mqttUsername: stranger }),
    ).rejects.toThrow('Not authorized');
  });
});

describe('[SEC-012] [PGR-005] after sign-in (PAGER-D4)', () => {
  it('ends a signed-in pager’s connection on a packet over the limit', async () => {
    const client = await connectPager(pager);
    const ended = closed(client);
    client.publish(pager.heartbeatTopic, Buffer.alloc(5_000, 0x20), { qos: 0 });
    await ended;
    expect(
      (await prisma.device.findUniqueOrThrow({ where: { id: pager.deviceId } })).lastSeenAt,
    ).toBeNull();
  });

  it('takes a heartbeat up to the packet limit', async () => {
    const client = await connectPager(pager);
    // A heartbeat with the longest firmware report it may carry is far below 4 KB.
    await client.publishAsync(
      pager.heartbeatTopic,
      JSON.stringify({
        battery: 80,
        rssi: -50,
        firmware: '1.0.0',
        ota: { version: '1.1.0', attempt: 1, state: 'FAILED', error: 'x'.repeat(120) },
      }),
      { qos: 1 },
    );
    expect(client.connected).toBe(true);
  });
});
