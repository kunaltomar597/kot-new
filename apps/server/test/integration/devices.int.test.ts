import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { Controller, Get, type INestApplication, Param, Req } from '@nestjs/common';
import {
  ApiError,
  DeviceListResponse,
  DeviceRevoked,
  DeviceSummary,
  deviceTokenMessage,
  PairedDevice,
  PairingCodeResponse,
  pairingProofMessage,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequireDevice } from '../../src/auth/decorators.js';
import type { AuthenticatedRequest } from '../../src/auth/principal.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { assertTableAccess } from '../../src/devices/device-scope.js';
import { DevicesService } from '../../src/devices/devices.service.js';
import {
  addDevice,
  authenticateDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
  TEST_PINS,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

@Controller('probe-table')
class TableProbeController {
  @Get(':tableId')
  @RequireDevice()
  read(@Req() request: AuthenticatedRequest, @Param('tableId') tableId: string) {
    assertTableAccess(request.device, tableId);
    return { tableId };
  }
}

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: { accessToken: string };
let tables: string[];

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, controllers: [TableProbeController] });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  const section = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  tables = [];
  for (const label of ['1', '2']) {
    tables.push(
      (
        await prisma.diningTable.create({
          data: { restaurantId: kit.restaurantId, sectionId: section.id, label },
        })
      ).id,
    );
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

const server = () => request(httpServer(app));
const asManager = () => authHeaders(kit.deviceId, manager.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

interface DeviceKeys {
  readonly algorithm: 'Ed25519' | 'ES256';
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

function keys(algorithm: 'Ed25519' | 'ES256' = 'Ed25519'): DeviceKeys {
  const pair =
    algorithm === 'Ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    algorithm,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey,
  };
}

/** Signs like the device would: raw signatures (r‖s for ECDSA, as WebCrypto produces). */
function deviceSign(key: DeviceKeys, message: string): string {
  const data = Buffer.from(message, 'utf8');
  const signature =
    key.algorithm === 'Ed25519'
      ? sign(null, data, key.privateKey)
      : sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return signature.toString('base64');
}

async function createCode(body: Record<string, unknown>) {
  const response = await server().post('/api/v1/devices/pairing-codes').set(asManager()).send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return PairingCodeResponse.parse(response.body);
}

function pair(code: string, key: DeviceKeys, proofKey: DeviceKeys = key) {
  return server()
    .post('/api/v1/devices/pair')
    .send({
      code,
      algorithm: key.algorithm,
      publicKey: key.publicKey,
      proof: deviceSign(proofKey, pairingProofMessage(code)),
      appVersion: '1.0.0',
    });
}

describe('[AUTH-007] pairing', () => {
  it('pairs a device with a manager code and its key; the device can then sign in', async () => {
    const code = await createCode({ type: 'WAITER_PHONE', name: 'Ravi phone' });
    // No TLS in this test app, so no CA fingerprint to pin (see tls.int.test.ts).
    expect(code.caSha256).toBeNull();
    expect(JSON.parse(code.qrPayload)).toEqual({ v: 1, code: code.code });
    const key = keys('ES256');
    const response = await pair(code.code, key);
    expect(response.status).toBe(201);
    const device = PairedDevice.parse(response.body);
    expect(device).toMatchObject({
      type: 'WAITER_PHONE',
      name: 'Ravi phone',
      restaurantId: kit.restaurantId,
    });

    await authenticateDevice(app, device.deviceId, key.privateKey);
    const login = await server()
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(device.deviceId))
      .send({ staffId: kit.staff.WAITER, pin: TEST_PINS.WAITER });
    expect(login.status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { action: 'DEVICE_PAIRED', entityId: device.deviceId },
      }),
    ).toBe(1);
  });

  it('uses each code once and only until it expires', async () => {
    const code = await createCode({ type: 'POS', name: 'Counter 2' });
    expect((await pair(code.code, keys())).status).toBe(201);
    expect(codeOf(await pair(code.code, keys()))).toBe('PAIRING_CODE_INVALID');

    vi.useFakeTimers({ toFake: ['Date'] });
    const late = await createCode({ type: 'POS', name: 'Counter 3' });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    expect(codeOf(await pair(late.code, keys()))).toBe('PAIRING_CODE_INVALID');
    expect(codeOf(await pair('ABCD-EFGH', keys()))).toBe('PAIRING_CODE_INVALID');
  });

  it('requires proof that the device holds the private key', async () => {
    const code = await createCode({ type: 'KDS', name: 'Tandoor screen' });
    expect(codeOf(await pair(code.code, keys(), keys()))).toBe('PAIRING_PROOF_INVALID');
    // An Ed25519 key declared as ES256 is refused.
    const ed = keys('Ed25519');
    const mismatched = await server()
      .post('/api/v1/devices/pair')
      .send({
        code: code.code,
        algorithm: 'ES256',
        publicKey: ed.publicKey,
        proof: deviceSign(ed, pairingProofMessage(code.code)),
      });
    expect(codeOf(mismatched)).toBe('PAIRING_PROOF_INVALID');
    // A failed proof does not use up the code.
    expect((await pair(code.code, keys())).status).toBe(201);
  });

  it('only lets managers create codes', async () => {
    const waiter = await signIn(app, kit, 'WAITER');
    const response = await server()
      .post('/api/v1/devices/pairing-codes')
      .set(authHeaders(kit.deviceId, waiter.accessToken))
      .send({ type: 'POS', name: 'Sneaky' });
    expect(response.status).toBe(403);
  });

  it('binds a table tablet to its table, which must exist', async () => {
    const missing = await server()
      .post('/api/v1/devices/pairing-codes')
      .set(asManager())
      .send({ type: 'TABLE_TABLET', name: 'Tablet 1' });
    expect(missing.status).toBe(400);
    const unknown = await server()
      .post('/api/v1/devices/pairing-codes')
      .set(asManager())
      .send({ type: 'TABLE_TABLET', name: 'Tablet 1', tableId: kit.staff.OWNER });
    expect(codeOf(unknown)).toBe('TABLE_NOT_FOUND');
    const code = await createCode({ type: 'TABLE_TABLET', name: 'Tablet 1', tableId: tables[0] });
    const device = PairedDevice.parse((await pair(code.code, keys())).body);
    expect(device.tableId).toBe(tables[0]);
  });
});

describe('[SEC-009] pairing rate limit', () => {
  it('refuses the 11th pairing attempt within a minute from one client', async () => {
    const own = await createTestDatabase();
    const ownApp = await createTestApp({ databaseUrl: own.url });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const key = keys();
        const response = await request(httpServer(ownApp))
          .post('/api/v1/devices/pair')
          .send({
            code: 'ZZZZ-ZZZZ',
            algorithm: key.algorithm,
            publicKey: key.publicKey,
            proof: deviceSign(key, pairingProofMessage('ZZZZ-ZZZZ')),
          });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await ownApp.close();
      await own.drop();
    }
  });
});

describe('[AUTH-007] [ONB-001] first device of a new installation', () => {
  it('gives the server PC a bootstrap code only while no device is paired', async () => {
    const fresh = await createTestDatabase();
    const freshApp = await createTestApp({ databaseUrl: fresh.url });
    try {
      const freshPrisma = freshApp.get(PrismaService);
      const noRestaurant = await request(httpServer(freshApp)).post(
        '/api/v1/devices/pairing-codes/bootstrap',
      );
      expect(codeOf(noRestaurant)).toBe('RESTAURANT_NOT_SET_UP');
      await freshPrisma.restaurant.create({ data: { displayName: 'New place' } });

      const bootstrap = await request(httpServer(freshApp)).post(
        '/api/v1/devices/pairing-codes/bootstrap',
      );
      expect(bootstrap.status).toBe(201);
      const code = PairingCodeResponse.parse(bootstrap.body);
      const key = keys();
      const paired = await request(httpServer(freshApp))
        .post('/api/v1/devices/pair')
        .send({
          code: code.code,
          algorithm: key.algorithm,
          publicKey: key.publicKey,
          proof: deviceSign(key, pairingProofMessage(code.code)),
        });
      expect(PairedDevice.parse(paired.body)).toMatchObject({ type: 'POS', name: 'Server POS' });

      const again = await request(httpServer(freshApp)).post(
        '/api/v1/devices/pairing-codes/bootstrap',
      );
      expect(codeOf(again)).toBe('BOOTSTRAP_CLOSED');
      await expect(freshApp.get(DevicesService).createBootstrapCode(false)).rejects.toMatchObject({
        code: 'BOOTSTRAP_CLOSED',
      });
    } finally {
      await freshApp.close();
      await fresh.drop();
    }
  });
});

describe('[AUTH-007] device tokens', () => {
  async function pairedDevice(): Promise<{ id: string; key: DeviceKeys }> {
    const code = await createCode({ type: 'WAITER_PHONE', name: 'Phone' });
    const key = keys();
    const device = PairedDevice.parse((await pair(code.code, key)).body);
    return { id: device.deviceId, key };
  }

  async function challengeFor(deviceId: string): Promise<string> {
    const response = await server().post('/api/v1/devices/challenge').send({ deviceId });
    return (response.body as { challenge: string }).challenge;
  }

  function token(deviceId: string, challenge: string, signature: string) {
    return server().post('/api/v1/devices/token').send({ deviceId, challenge, signature });
  }

  it('needs a fresh challenge signed with the device key, used once', async () => {
    const { id, key } = await pairedDevice();
    const challenge = await challengeFor(id);
    const signature = deviceSign(key, deviceTokenMessage(id, challenge));
    expect((await token(id, challenge, signature)).status).toBe(200);
    expect(codeOf(await token(id, challenge, signature))).toBe('DEVICE_AUTH_FAILED');

    const other = await challengeFor(id);
    expect(codeOf(await token(id, other, deviceSign(keys(), deviceTokenMessage(id, other))))).toBe(
      'DEVICE_AUTH_FAILED',
    );
  });

  it('refuses a challenge issued for another device, and an expired one', async () => {
    const first = await pairedDevice();
    const second = await pairedDevice();
    const challenge = await challengeFor(first.id);
    const stolen = deviceSign(second.key, deviceTokenMessage(second.id, challenge));
    expect(codeOf(await token(second.id, challenge, stolen))).toBe('DEVICE_AUTH_FAILED');

    vi.useFakeTimers({ toFake: ['Date'] });
    const old = await challengeFor(first.id);
    vi.setSystemTime(Date.now() + 61_000);
    const late = deviceSign(first.key, deviceTokenMessage(first.id, old));
    expect(codeOf(await token(first.id, old, late))).toBe('DEVICE_AUTH_FAILED');
  });
});

describe('[AUTH-008] unpairing', () => {
  it('stops the device token and every session on the device at once, and emits DeviceRevoked', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const waiter = await signIn(app, kit, 'WAITER', phone);
    const tiles = await server().get('/api/v1/auth/staff-tiles').set(authHeaders(phone));
    expect(tiles.status).toBe(200);

    const response = await server()
      .post(`/api/v1/devices/${phone}/revoke`)
      .set(asManager())
      .send({ reason: 'Phone lost' });
    expect(response.status).toBe(200);
    expect(DeviceSummary.parse(response.body).status).toBe('REVOKED');

    const afterTiles = await server().get('/api/v1/auth/staff-tiles').set(authHeaders(phone));
    expect(codeOf(afterTiles)).toBe('DEVICE_NOT_RECOGNISED');
    const afterLogin = await server()
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(phone))
      .send({ staffId: kit.staff.WAITER, pin: TEST_PINS.WAITER });
    expect(codeOf(afterLogin)).toBe('DEVICE_NOT_RECOGNISED');
    const session = await prisma.session.findUniqueOrThrow({ where: { id: waiter.session.id } });
    expect(session.revokeReason).toBe('DEVICE_REVOKED');

    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: phone } });
    expect(DeviceRevoked.parse(event.payload).payload).toEqual({
      deviceId: phone,
      deviceType: 'WAITER_PHONE',
      reason: 'Phone lost',
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'DEVICE_REVOKED', entityId: phone } }),
    ).toBe(1);

    const again = await server()
      .post(`/api/v1/devices/${phone}/revoke`)
      .set(asManager())
      .send({ reason: 'Phone lost' });
    expect(again.status).toBe(200);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: phone } })).toBe(1);
  });

  it('refuses to unpair the device the manager is using', async () => {
    const response = await server()
      .post(`/api/v1/devices/${kit.deviceId}/revoke`)
      .set(asManager())
      .send({ reason: 'Oops' });
    expect(codeOf(response)).toBe('CANNOT_REVOKE_OWN_DEVICE');
  });

  it('lists devices without their keys', async () => {
    const response = await server().get('/api/v1/devices').set(asManager());
    const body = DeviceListResponse.parse(response.body);
    expect(body.devices.some((device) => device.status === 'REVOKED')).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(/PUBLIC KEY|publicKey/);
  });
});

describe('[AUTH-009] [SEC-003] table tablets', () => {
  it('can only act on their own table; other devices are not limited by table', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: tables[0]! });
    expect(
      (await server().get(`/api/v1/probe-table/${tables[0]!}`).set(authHeaders(tablet))).status,
    ).toBe(200);
    const other = await server().get(`/api/v1/probe-table/${tables[1]!}`).set(authHeaders(tablet));
    expect(codeOf(other)).toBe('NOT_THIS_TABLE');
    expect(
      (await server().get(`/api/v1/probe-table/${tables[1]!}`).set(authHeaders(kit.deviceId)))
        .status,
    ).toBe(200);
  });

  it('moves to another table only with a manager, and is audited', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: tables[0]! });
    const waiter = await signIn(app, kit, 'WAITER');
    const refused = await server()
      .put(`/api/v1/devices/${tablet}/table`)
      .set(authHeaders(kit.deviceId, waiter.accessToken))
      .send({ tableId: tables[1] });
    expect(refused.status).toBe(403);

    const moved = await server()
      .put(`/api/v1/devices/${tablet}/table`)
      .set(asManager())
      .send({ tableId: tables[1] });
    expect(DeviceSummary.parse(moved.body).tableId).toBe(tables[1]);
    expect(
      (await server().get(`/api/v1/probe-table/${tables[1]!}`).set(authHeaders(tablet))).status,
    ).toBe(200);
    expect(
      await prisma.auditLog.count({ where: { action: 'DEVICE_TABLE_CHANGED', entityId: tablet } }),
    ).toBe(1);

    const notTablet = await server()
      .put(`/api/v1/devices/${kit.deviceId}/table`)
      .set(asManager())
      .send({ tableId: tables[1] });
    expect(codeOf(notTablet)).toBe('NOT_A_TABLE_TABLET');
  });
});

describe('[AUTH-007] [AUTH-009] the current device', () => {
  it('tells a device its own type and binding, as a manager last set them', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: tables[0]! });
    const before = DeviceSummary.parse(
      (await server().get('/api/v1/devices/current').set(authHeaders(tablet)).expect(200)).body,
    );
    expect(before).toMatchObject({ id: tablet, type: 'TABLE_TABLET', tableId: tables[0] });
    await server()
      .put(`/api/v1/devices/${tablet}/table`)
      .set(asManager())
      .send({ tableId: tables[1] })
      .expect(200);
    const after = DeviceSummary.parse(
      (await server().get('/api/v1/devices/current').set(authHeaders(tablet)).expect(200)).body,
    );
    expect(after.tableId).toBe(tables[1]);
  });

  it('needs a paired device', async () => {
    expect(codeOf(await server().get('/api/v1/devices/current'))).toBe('DEVICE_NOT_RECOGNISED');
  });
});
