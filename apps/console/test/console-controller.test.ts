// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ConsoleController } from '../src/app/console-controller.js';
import { BrowserStorage, MemoryStorage } from '../src/app/storage.js';
import { FakeServer } from './fake-server.js';
import {
  DEVICE_ID,
  deviceSummary,
  fakeKey,
  inMinutes,
  login,
  RESTAURANT_ID,
  SocketFactory,
  STAFF,
} from './fakes.js';

const BASE = 'http://pos.test';

function server(): FakeServer {
  return new FakeServer()
    .on('POST', '/api/v1/devices/pair', () => ({
      status: 201,
      body: {
        deviceId: DEVICE_ID,
        restaurantId: RESTAURANT_ID,
        type: 'POS',
        name: 'Counter POS',
        tableId: null,
        stationId: null,
        staffId: null,
      },
    }))
    .on('POST', '/api/v1/devices/challenge', () => ({
      status: 200,
      body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
    }))
    .on('POST', '/api/v1/devices/token', () => ({
      status: 200,
      body: { deviceToken: 'device-token-1', expiresAt: inMinutes(60) },
    }))
    .on('GET', '/api/v1/devices/current', () => ({ status: 200, body: deviceSummary() }))
    .on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 200,
      body: { staff: Object.values(STAFF) },
    }))
    .on('POST', '/api/v1/auth/pin-login', () => ({ status: 200, body: login('MANAGER') }))
    .on('POST', '/api/v1/auth/logout', () => ({ status: 204 }))
    .on('GET', '/api/v1/auth/session', () => {
      const { session, staff, secondFactorValidUntil } = login('MANAGER');
      return { status: 200, body: { session, staff, secondFactorValidUntil } };
    });
}

function setup(fake = server(), storage = new MemoryStorage()) {
  const sockets = new SocketFactory();
  const controller = new ConsoleController({
    baseUrl: BASE,
    storage,
    fetch: fake.fetch,
    connect: sockets.connect,
    generateKey: fakeKey,
    keyFromPair: async () => (await fakeKey()).key,
    appVersion: '0.1.0-test',
  });
  return { controller, storage, sockets, fake };
}

async function paired() {
  const context = setup();
  await context.controller.start();
  await context.controller.pair('ABCD-EFGH');
  return context;
}

describe('[AUTH-007] pairing and restarting the console', () => {
  it('starts unpaired, then pairs, stores the device and goes live', async () => {
    const { controller, storage, sockets } = setup();
    await controller.start();
    expect(controller.getSnapshot().phase).toBe('unpaired');

    await controller.pair('ABCD-EFGH');

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'paired',
      device: { name: 'Counter POS' },
      person: undefined,
    });
    expect(storage.device?.device).toMatchObject({ deviceId: DEVICE_ID });
    expect(sockets.last.url).toBe(`${BASE}/rt`);
    sockets.sync(3);
    expect(controller.getSnapshot().connection).toBe('online');
    expect(storage.resume).toMatchObject({ lastSequence: 3 });
  });

  it('comes back after a restart with the stored device and session', async () => {
    const first = await paired();
    await first.controller.signIn(STAFF.MANAGER.staffId, '2222');
    first.controller.stop();

    const again = setup(server(), first.storage);
    await again.controller.start();
    expect(again.controller.getSnapshot()).toMatchObject({
      phase: 'paired',
      person: { displayName: 'Meera', role: 'MANAGER' },
    });
    await expect(again.sockets.last.handshake()).resolves.toMatchObject({
      accessToken: 'access-MANAGER',
    });
  });

  it('keeps working from what it stored when the server cannot be reached', async () => {
    const first = await paired();
    first.controller.stop();
    const offline = new FakeServer();
    const again = setup(offline, first.storage);
    const unreachable = Object.assign(offline, {
      fetch: () => Promise.reject(new TypeError('offline')),
    });
    const controller = new ConsoleController({
      baseUrl: BASE,
      storage: first.storage,
      fetch: unreachable.fetch,
      connect: again.sockets.connect,
      keyFromPair: async () => (await fakeKey()).key,
    });
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'paired',
      device: { name: 'Counter POS' },
    });
  });

  it('forgets a device that was unpaired while it was away', async () => {
    const first = await paired();
    first.controller.stop();
    const refusing = server()
      .on('GET', '/api/v1/devices/current', () => ({
        status: 401,
        body: { code: 'DEVICE_NOT_RECOGNISED', message: 'Pair it.' },
      }))
      .on('POST', '/api/v1/devices/token', () => ({
        status: 401,
        body: { code: 'DEVICE_AUTH_FAILED', message: 'Pair it again.' },
      }));
    const again = setup(refusing, first.storage);
    await again.controller.start();
    await expect.poll(() => again.controller.getSnapshot().phase).toBe('unpaired');
    expect(again.controller.getSnapshot().notice).toBe('revoked');
    await expect.poll(() => first.storage.device).toBeUndefined();
  });
});

describe('[AUTH-001] [AUTH-005] signing in and out', () => {
  it('lists staff, signs a person in and out, reconnecting with their rooms', async () => {
    const { controller, sockets } = await paired();
    expect((await controller.staffTiles()).map((person) => person.displayName)).toContain('Meera');

    await controller.signIn(STAFF.MANAGER.staffId, '2222');
    expect(controller.getSnapshot().person?.role).toBe('MANAGER');
    await expect(sockets.last.handshake()).resolves.toMatchObject({
      accessToken: 'access-MANAGER',
    });

    await controller.keepAlive();
    await controller.signOut('signedOutInactive');
    expect(controller.getSnapshot()).toMatchObject({
      person: undefined,
      notice: 'signedOutInactive',
    });
    expect(await sockets.last.handshake()).not.toHaveProperty('accessToken');
    controller.dismissNotice();
    expect(controller.getSnapshot().notice).toBeUndefined();
    await controller.keepAlive();
  });

  it('shows the person signed out when the server ends the session', async () => {
    const fake = server().on('GET', '/api/v1/auth/session', () => ({
      status: 401,
      body: { code: 'SESSION_EXPIRED', message: 'Signed out after inactivity.' },
    }));
    const { controller } = setup(fake);
    await controller.start();
    await controller.pair('ABCD-EFGH');
    await controller.signIn(STAFF.MANAGER.staffId, '2222');

    await controller.keepAlive();

    expect(controller.getSnapshot()).toMatchObject({
      person: undefined,
      notice: 'signedOutInactive',
    });
  });

  it('shows why when the live connection says the session ended', async () => {
    const { controller, sockets } = await paired();
    await controller.signIn(STAFF.MANAGER.staffId, '2222');
    sockets.last.fire('ended', { reason: 'SESSION_ENDED' });
    sockets.last.fire('disconnect', 'io server disconnect');
    expect(controller.getSnapshot()).toMatchObject({ person: undefined, notice: 'signedOut' });
  });

  it('goes back to pairing when the device is unpaired', async () => {
    const { controller, sockets, storage } = await paired();
    const events: string[] = [];
    const off = controller.onEvent((event) => events.push(event.type));
    sockets.sync(1);
    sockets.last.fire('event', {
      sequence: 2,
      event: {
        eventId: '0199a0e0-0000-4000-8000-000000000999',
        type: 'MenuPublished',
        version: 1,
        occurredAt: new Date().toISOString(),
        restaurantId: RESTAURANT_ID,
        businessDate: '2026-09-25',
        payload: { menuVersion: 2 },
      },
    });
    off();
    expect(events).toEqual(['MenuPublished']);

    sockets.last.fire('ended', { reason: 'DEVICE_REVOKED' });
    sockets.last.fire('disconnect', 'io server disconnect');

    expect(controller.getSnapshot()).toMatchObject({ phase: 'unpaired', notice: 'revoked' });
    await expect.poll(() => storage.device).toBeUndefined();
  });
});

describe('[SEC-006] the device key stays a key object in IndexedDB', () => {
  it('stores and reloads the non-extractable key pair, the device and the session', async () => {
    const storage = new BrowserStorage(indexedDB, memoryStorage(), memoryStorage());
    const { keyPair } = await fakeKey();
    await storage.saveDevice({
      keyPair,
      device: { deviceId: DEVICE_ID, deviceToken: 'device-token-1' },
      summary: deviceSummary(),
    });
    const loaded = await storage.loadDevice();
    expect(loaded?.device.deviceToken).toBe('device-token-1');
    expect(loaded?.keyPair.privateKey.extractable).toBe(false);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      loaded!.keyPair.privateKey,
      new TextEncoder().encode('hello'),
    );
    expect(signature.byteLength).toBe(64);

    storage.saveSession(login('CASHIER'));
    expect(storage.loadSession()?.staff.role).toBe('CASHIER');
    storage.saveResume({ lastSequence: 5, streamId: '0199a0e0-0000-4000-8000-00000000f001' });
    expect(storage.loadResume()?.lastSequence).toBe(5);

    await storage.saveDevice(undefined);
    storage.saveSession(undefined);
    storage.saveResume(undefined);
    expect(await storage.loadDevice()).toBeUndefined();
    expect(storage.loadSession()).toBeUndefined();
    expect(storage.loadResume()).toBeUndefined();
  });

  it('ignores stored values that no longer fit', () => {
    const tab = memoryStorage();
    tab.setItem('rp-console.session', '{"broken":');
    const local = memoryStorage();
    local.setItem('rp-console.resume', JSON.stringify({ lastSequence: -1 }));
    const storage = new BrowserStorage(indexedDB, tab, local);
    expect(storage.loadSession()).toBeUndefined();
    expect(storage.loadResume()).toBeUndefined();
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
