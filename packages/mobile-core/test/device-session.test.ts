import { describe, expect, it } from 'vitest';
import {
  DeviceSession,
  InvalidServerAddressError,
  MemoryStore,
  normalizeServerUrl,
} from '../src/index.js';
import {
  DEVICE_ID,
  FakeKeys,
  itemReadyFrame,
  type FakeServer,
  fakeLocalServer as server,
  SocketFactory,
  STAFF,
} from '../src/testing/index.js';

const ADDRESS = 'http://pos.test:3000';

interface Device {
  readonly secureStore: MemoryStore;
  readonly plainStore: MemoryStore;
  readonly keys: FakeKeys;
}

function newDevice(): Device {
  return { secureStore: new MemoryStore(), plainStore: new MemoryStore(), keys: new FakeKeys() };
}

function setup(fake: Pick<FakeServer, 'fetch'> = server(), device = newDevice()) {
  const sockets = new SocketFactory();
  const errors: unknown[] = [];
  const session = new DeviceSession({
    ...device,
    fetch: fake.fetch,
    connect: sockets.connect,
    appVersion: '0.1.0-test',
    onError: (error) => errors.push(error),
  });
  return { session, sockets, device, errors };
}

async function paired() {
  const context = setup();
  await context.session.start();
  await context.session.pair(ADDRESS, 'abcd-efgh');
  return context;
}

describe('[AUTH-007] [SEC-010] pairing a phone or tablet', () => {
  it('starts unpaired, pairs with a Keystore key and goes live', async () => {
    const fake = server();
    const { session, sockets, device } = setup(fake);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getSnapshot().phase));
    await session.start();
    expect(session.getSnapshot().phase).toBe('unpaired');
    expect(() => session.api).toThrow('not paired');

    await session.pair(` ${ADDRESS} `, 'abcd-efgh');

    expect(session.getSnapshot()).toMatchObject({
      phase: 'paired',
      serverUrl: ADDRESS,
      device: { name: 'Waiter phone 1' },
      person: undefined,
    });
    expect(fake.callsTo('POST', '/api/v1/devices/pair')[0]?.body).toMatchObject({
      code: 'ABCD-EFGH',
      algorithm: 'ES256',
      publicKey: 'AAAA1',
      appVersion: '0.1.0-test',
    });
    expect(device.keys.created).toBe(1);
    expect(await device.plainStore.getItem('rp.server.v1')).toBe(ADDRESS);
    await expect.poll(() => device.secureStore.getItem('rp.credentials.v1')).toContain(DEVICE_ID);
    expect(sockets.last.url).toBe(`${ADDRESS}/rt`);
    sockets.sync(3);
    expect(session.getSnapshot().connection).toBe('online');
    await expect.poll(() => device.plainStore.getItem('rp.resume.v1')).toContain('3');
    expect(seen).toContain('paired');
  });

  it('comes back after a restart with the stored device, person and resume point', async () => {
    const first = await paired();
    await first.session.signIn(STAFF.WAITER.staffId, '4444');
    first.sockets.sync(7);
    await expect.poll(() => first.device.plainStore.getItem('rp.resume.v1')).toContain('7');
    first.session.stop();

    const again = setup(server(), first.device);
    await again.session.start();
    expect(again.session.getSnapshot()).toMatchObject({
      phase: 'paired',
      person: { displayName: 'Ravi', role: 'WAITER' },
    });
    await expect(again.sockets.last.handshake()).resolves.toMatchObject({
      accessToken: 'access-WAITER',
    });
  });

  it('keeps working from what it stored when the server cannot be reached', async () => {
    const first = await paired();
    await first.session.signIn(STAFF.WAITER.staffId, '4444');
    first.session.stop();
    const offline = { fetch: () => Promise.reject(new TypeError('offline')) };
    const again = setup(offline, first.device);
    await again.session.start();
    expect(again.session.getSnapshot()).toMatchObject({
      phase: 'paired',
      device: undefined,
      person: { displayName: 'Ravi' },
    });
    expect(again.errors).not.toHaveLength(0);
  });

  it('forgets a device that was unpaired while it was away, key and all', async () => {
    const first = await paired();
    first.session.stop();
    const refusing = server()
      .on('GET', '/api/v1/devices/current', () => ({
        status: 401,
        body: { code: 'DEVICE_NOT_RECOGNISED', message: 'Pair it.' },
      }))
      .on('POST', '/api/v1/devices/token', () => ({
        status: 401,
        body: { code: 'DEVICE_AUTH_FAILED', message: 'Pair it again.' },
      }));
    const again = setup(refusing, first.device);
    await again.session.start();
    await expect.poll(() => again.session.getSnapshot().phase).toBe('unpaired');
    expect(again.session.getSnapshot().notice).toBe('revoked');
    await expect.poll(() => first.device.keys.key).toBeUndefined();
    await expect.poll(() => first.device.secureStore.getItem('rp.credentials.v1')).toBeNull();
  });

  it('refuses an address that is not a server', async () => {
    const { session, device } = setup();
    await session.start();
    await expect(session.pair('ftp://pos.test', 'ABCD-EFGH')).rejects.toThrow(
      InvalidServerAddressError,
    );
    expect(device.keys.created).toBe(0);
  });
});

describe('[AUTH-001] [AUTH-005] staff on the device', () => {
  it('lists staff, signs a person in and out, reconnecting with their rooms', async () => {
    const { session, sockets } = await paired();
    expect((await session.staffTiles()).map((person) => person.displayName)).toContain('Ravi');

    await session.signIn(STAFF.WAITER.staffId, '4444');
    expect(session.getSnapshot().person?.role).toBe('WAITER');
    await expect(sockets.last.handshake()).resolves.toMatchObject({
      accessToken: 'access-WAITER',
    });

    await session.keepAlive();
    await session.signOut('signedOutInactive');
    expect(session.getSnapshot()).toMatchObject({ person: undefined, notice: 'signedOutInactive' });
    expect(await sockets.last.handshake()).not.toHaveProperty('accessToken');
    session.dismissNotice();
    session.dismissNotice();
    expect(session.getSnapshot().notice).toBeUndefined();
    await session.keepAlive();
  });

  it('shows the person signed out when the server ends the session', async () => {
    const fake = server().on('GET', '/api/v1/auth/session', () => ({
      status: 401,
      body: { code: 'SESSION_EXPIRED', message: 'Signed out after inactivity.' },
    }));
    const { session } = setup(fake);
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    await session.signIn(STAFF.WAITER.staffId, '4444');
    await session.keepAlive();
    expect(session.getSnapshot()).toMatchObject({
      person: undefined,
      notice: 'signedOutInactive',
    });
  });

  it('shows why when the live connection says the session ended', async () => {
    const { session, sockets } = await paired();
    await session.signIn(STAFF.WAITER.staffId, '4444');
    sockets.last.fire('ended', { reason: 'SESSION_ENDED' });
    sockets.last.fire('disconnect', 'io server disconnect');
    expect(session.getSnapshot()).toMatchObject({ person: undefined, notice: 'signedOut' });
  });

  it('passes live events to the screens until they unsubscribe', async () => {
    const { session, sockets } = await paired();
    sockets.sync(0);
    const seen: string[] = [];
    const stop = session.onEvent((event) => seen.push(event.type));
    sockets.last.fire('event', itemReadyFrame(1));
    stop();
    sockets.last.fire('event', itemReadyFrame(2));
    expect(seen).toEqual(['ItemStatusChanged']);
  });
});

describe('server addresses', () => {
  it.each([
    ['192.168.1.20:8443', 'https://192.168.1.20:8443'],
    ['https://pos.local:8443/', 'https://pos.local:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    '',
    'ftp://pos',
    'https://pos/path',
    'https://user@pos',
    'http://[bad',
    'https://pos?x',
  ])('refuses %j', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow(InvalidServerAddressError);
  });
});
