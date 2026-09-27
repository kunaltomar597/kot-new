import { describe, expect, it } from 'vitest';
import {
  DeviceSession,
  findServer,
  InvalidServerAddressError,
  MemoryStore,
  normalizeServerUrl,
  ServerMismatchError,
  type ServerTrust,
  ServerUnreachableError,
  UnverifiedServerError,
} from '../src/index.js';
import {
  DEVICE_ID,
  FakeKeys,
  FakeTrust,
  itemReadyFrame,
  LAN_CA,
  OTHER_CA,
  type FakeServer,
  fakeLocalServer as server,
  SocketFactory,
  STAFF,
} from '../src/testing/index.js';

const ADDRESS = 'http://pos.test:3000';
/** The restaurant's server over TLS, and another address on the same network. */
const LAN = 'https://192.168.1.20:8443';
const ELSEWHERE = 'https://10.0.0.5:8443';

interface Device {
  readonly secureStore: MemoryStore;
  readonly plainStore: MemoryStore;
  readonly keys: FakeKeys;
}

function newDevice(): Device {
  return { secureStore: new MemoryStore(), plainStore: new MemoryStore(), keys: new FakeKeys() };
}

function setup(
  fake: Pick<FakeServer, 'fetch'> = server(),
  device = newDevice(),
  trust?: ServerTrust,
) {
  const sockets = new SocketFactory();
  const errors: unknown[] = [];
  const session = new DeviceSession({
    ...device,
    ...(trust !== undefined && { trust }),
    fetch: fake.fetch,
    connect: sockets.connect,
    appVersion: '0.1.0-test',
    onError: (error) => errors.push(error),
  });
  return { session, sockets, device, errors };
}

/** A server that no longer knows the device: it was unpaired while the device was away. */
function unpairingServer(): FakeServer {
  return server()
    .on('GET', '/api/v1/devices/current', () => ({
      status: 401,
      body: { code: 'DEVICE_NOT_RECOGNISED', message: 'Pair it.' },
    }))
    .on('POST', '/api/v1/devices/token', () => ({
      status: 401,
      body: { code: 'DEVICE_AUTH_FAILED', message: 'Pair it again.' },
    }));
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
    const again = setup(unpairingServer(), first.device);
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

describe('[SEC-010] [AUTH-007] pairing over the restaurant LAN certificate (ADR-0011)', () => {
  it('pairs from the QR code with the server whose CA it names, pinned before the code is sent', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const fake = server();
    let pinnedAtFirstRequest: FakeTrust['pinned'] | 'no request' = 'no request';
    const recording: typeof fetch = (input, init) => {
      if (pinnedAtFirstRequest === 'no request') pinnedAtFirstRequest = trust.pinned;
      return fake.fetch(input, init);
    };
    const { session } = setup({ fetch: recording }, newDevice(), trust);
    await session.start();

    const found = await session.findServer({
      servers: [ELSEWHERE, LAN],
      caSha256: LAN_CA.sha256,
    });
    expect(found).toEqual({ serverUrl: LAN, authority: LAN_CA, verified: true });
    await session.pair(found.serverUrl, 'ABCD-EFGH', found.authority);

    expect(pinnedAtFirstRequest).toEqual({ certificate: LAN_CA.certificate, serverUrl: LAN });
    expect(session.getSnapshot()).toMatchObject({ phase: 'paired', serverUrl: LAN });
    expect(fake.callsTo('POST', '/api/v1/devices/pair')).toHaveLength(1);
  });

  it('passes over a stranger with another CA for the server the QR code names', async () => {
    const trust = new FakeTrust().serve(ELSEWHERE, OTHER_CA).serve(LAN, LAN_CA);
    const { session } = setup(server(), newDevice(), trust);
    await expect(
      session.findServer({ servers: [ELSEWHERE, LAN], caSha256: LAN_CA.sha256 }),
    ).resolves.toMatchObject({ serverUrl: LAN, verified: true });
  });

  it('refuses a server whose CA is not the one in the QR code', async () => {
    const trust = new FakeTrust().serve(LAN, OTHER_CA);
    const { session, device } = setup(server(), newDevice(), trust);
    await expect(
      session.findServer({ servers: [ELSEWHERE, LAN], caSha256: LAN_CA.sha256 }),
    ).rejects.toThrow(ServerMismatchError);
    expect(trust.pinned).toBeUndefined();
    expect(device.keys.created).toBe(0);
  });

  it('says the server did not answer when no address does, trying each once', async () => {
    const trust = new FakeTrust();
    const { session } = setup(server(), newDevice(), trust);
    const failure = session.findServer({
      servers: [LAN, `${ELSEWHERE}/`, ELSEWHERE],
      caSha256: LAN_CA.sha256,
    });
    await expect(failure).rejects.toThrow(ServerUnreachableError);
    await expect(failure).rejects.toMatchObject({ servers: [LAN, ELSEWHERE] });
    expect(trust.fetched).toEqual([LAN, ELSEWHERE]);
  });

  it('tries only secure addresses for a server whose CA the QR code names', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const { session } = setup(server(), newDevice(), trust);
    await expect(
      session.findServer({ servers: ['http://192.168.1.20:3000'], caSha256: LAN_CA.sha256 }),
    ).rejects.toThrow(InvalidServerAddressError);
    await expect(
      session.findServer({
        servers: ['http://192.168.1.20:3000', LAN],
        caSha256: LAN_CA.sha256,
      }),
    ).resolves.toMatchObject({ serverUrl: LAN, verified: true });
  });

  it('shows the CA of a typed address for a person to compare and pairs only once they have', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const fake = server();
    const { session, device } = setup(fake, newDevice(), trust);
    await session.start();

    await expect(session.findServer({ servers: ['192.168.1.20:8443'] })).resolves.toEqual({
      serverUrl: LAN,
      authority: LAN_CA,
      verified: false,
    });
    await expect(session.pair('192.168.1.20:8443', 'ABCD-EFGH')).rejects.toThrow(
      UnverifiedServerError,
    );
    expect(fake.calls).toHaveLength(0);
    expect(device.keys.created).toBe(0);

    // The person compared the fingerprint with the one the POS shows.
    await session.pair('192.168.1.20:8443', 'ABCD-EFGH', LAN_CA);
    expect(trust.pinned).toEqual({ certificate: LAN_CA.certificate, serverUrl: LAN });
    expect(session.getSnapshot().phase).toBe('paired');
  });

  it('does not pair when the device pinned another CA than the one checked', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    trust.pinAnswer = OTHER_CA.sha256;
    const fake = server();
    const { session, device } = setup(fake, newDevice(), trust);
    await session.start();
    await expect(session.pair(LAN, 'ABCD-EFGH', LAN_CA)).rejects.toThrow(ServerMismatchError);
    expect(trust).toMatchObject({ pinned: undefined, clears: 1 });
    expect(fake.calls).toHaveLength(0);
    expect(device.keys.created).toBe(0);
  });

  it('forgets the pinned CA when the server has unpaired the device', async () => {
    const trust = new FakeTrust().serve(LAN, LAN_CA);
    const first = setup(server(), newDevice(), trust);
    await first.session.start();
    await first.session.pair(LAN, 'ABCD-EFGH', LAN_CA);
    first.session.stop();
    expect(trust.pinned?.serverUrl).toBe(LAN);

    const again = setup(unpairingServer(), first.device, trust);
    await again.session.start();
    await expect.poll(() => trust.clears).toBe(1);
    expect(trust.pinned).toBeUndefined();
    expect(again.session.getSnapshot().notice).toBe('revoked');
  });
});

describe('[AUTH-007] finding a development server without TLS', () => {
  it('asks every address at once and takes the first that answers', async () => {
    const fake = server();
    const somewhere: typeof fetch = (input, init) =>
      (input instanceof Request ? input.url : input.toString()).startsWith('http://10.0.2.2')
        ? Promise.reject(new TypeError('Network request failed'))
        : fake.fetch(input, init);
    const trust = new FakeTrust();
    const { session } = setup({ fetch: somewhere }, newDevice(), trust);
    await expect(
      session.findServer({ servers: ['http://10.0.2.2:3000', 'http://192.168.1.20:3000'] }),
    ).resolves.toEqual({
      serverUrl: 'http://192.168.1.20:3000',
      authority: undefined,
      verified: false,
    });
    expect(fake.callsTo('GET', '/api/v1/health')).toHaveLength(1);
    expect(trust.fetched).toEqual([]);
  });

  it('takes a single address as it is and gives up on addresses that do not answer in time', async () => {
    const silent: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Timed out', 'AbortError'));
        });
      });
    await expect(
      findServer({ servers: ['http://10.0.2.2:3000'] }, { fetch: silent }),
    ).resolves.toMatchObject({ serverUrl: 'http://10.0.2.2:3000' });
    await expect(
      findServer(
        { servers: ['http://10.0.2.2:3000', 'http://192.168.1.20:3000'] },
        { fetch: silent, timeoutMs: 10 },
      ),
    ).rejects.toThrow(ServerUnreachableError);
    await expect(findServer({ servers: [] })).rejects.toThrow(InvalidServerAddressError);
  });

  it('pairs without pinning over plain HTTP, even with the trust module', async () => {
    const trust = new FakeTrust();
    const { session } = setup(server(), newDevice(), trust);
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    expect(trust.pinned).toBeUndefined();
    expect(session.getSnapshot().phase).toBe('paired');
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
