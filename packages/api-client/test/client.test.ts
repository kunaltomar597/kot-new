import { createPublicKey, verify } from 'node:crypto';
import { deviceTokenMessage, type LoginResponse, pairingProofMessage } from '@rp/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiClient,
  ApiContractError,
  ApiRequestError,
  ApiUnavailableError,
  CORRELATION_HEADER,
  DeviceKeyUnavailableError,
  generateWebCryptoDeviceKey,
  newIdempotencyKey,
  type StoredCredentials,
} from '../src/index.js';
import { FakeServer } from './helpers/fake-server.js';

const BASE = 'http://pos.test:8080';
const DEVICE_ID = '0199a0e0-0000-7000-8000-000000000001';
const STAFF_ID = '0199a0e0-0000-7000-8000-000000000002';
const SESSION_ID = '0199a0e0-0000-7000-8000-000000000003';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function login(accessToken: string, refreshToken: string, minutes = 15): LoginResponse {
  return {
    accessToken,
    accessTokenExpiresAt: inMinutes(minutes),
    refreshToken,
    session: { id: SESSION_ID, expiresAt: inMinutes(600), inactivityTimeoutSeconds: 600 },
    staff: { id: STAFF_ID, displayName: 'Asha', role: 'CASHIER' },
    secondFactorValidUntil: null,
  };
}

const PAIRED: StoredCredentials = {
  device: { deviceId: DEVICE_ID, deviceToken: 'device-1', deviceTokenExpiresAt: inMinutes(60) },
};

function signedIn(session: LoginResponse = login('access-1', 'refresh-token-number-1')) {
  return { ...PAIRED, session };
}

const TILES = { staff: [] };
const DEVICES = { devices: [] };

describe('[INT-002] typed REST calls checked against the contracts', () => {
  it('sends public, device and session calls with the right credentials', async () => {
    const server = new FakeServer()
      .on('GET', '/api/v1/version', () => ({
        status: 200,
        body: { name: 'rp-server', version: '0.1.0', apiVersion: 'v1', node: '24.1.0' },
      }))
      .on('GET', '/api/v1/auth/staff-tiles', () => ({ status: 200, body: TILES }))
      .on('GET', '/api/v1/devices', () => ({ status: 200, body: DEVICES }));
    const client = new ApiClient({
      baseUrl: `${BASE}/`,
      fetch: server.fetch,
      credentials: signedIn(),
    });

    await client.api.getVersion();
    await client.request('listStaffTiles');
    await client.api.listDevices();

    const [version, tiles, devices] = server.calls;
    expect(version?.headers['x-device-token']).toBeUndefined();
    expect(version?.headers.authorization).toBeUndefined();
    expect(tiles?.headers['x-device-token']).toBe('device-1');
    expect(tiles?.headers.authorization).toBeUndefined();
    expect(devices?.headers['x-device-token']).toBe('device-1');
    expect(devices?.headers.authorization).toBe('Bearer access-1');
    for (const call of server.calls) expect(call.headers[CORRELATION_HEADER]).toMatch(UUID);
  });

  it('fills path parameters, sends the checked body and passes an override token', async () => {
    const summary = {
      id: DEVICE_ID,
      type: 'POS',
      name: 'Till 2',
      status: 'REVOKED',
      tableId: null,
      stationId: null,
      staffId: null,
      pairedAt: null,
      lastSeenAt: null,
      appVersion: null,
    };
    const server = new FakeServer().on('POST', `/api/v1/devices/${DEVICE_ID}/revoke`, () => ({
      status: 200,
      body: summary,
    }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: signedIn() });

    const result = await client.api.revokeDevice({
      params: { deviceId: DEVICE_ID },
      body: { reason: '  Stolen from the counter ' },
      overrideToken: 'override-1',
      correlationId: 'support-42',
    });

    expect(result.status).toBe('REVOKED');
    const [call] = server.calls;
    expect(call?.body).toEqual({ reason: 'Stolen from the counter' });
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['x-override-token']).toBe('override-1');
    expect(call?.headers[CORRELATION_HEADER]).toBe('support-42');
  });

  it('refuses to send a request that breaks the contract', async () => {
    const server = new FakeServer();
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: PAIRED });
    await expect(client.api.pinLogin({ body: { staffId: STAFF_ID, pin: 'abcd' } })).rejects.toThrow(
      ApiContractError,
    );
    await expect(
      client.request('revokeDevice', {
        params: { deviceId: 'not-a-uuid' },
        body: { reason: 'Lost' },
      }),
    ).rejects.toThrow(/path parameters/);
    expect(server.calls).toHaveLength(0);
  });

  it('rejects an answer that breaks the contract', async () => {
    const server = new FakeServer().on('GET', '/api/v1/version', () => ({
      status: 200,
      body: { version: 7 },
    }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch });
    await expect(client.api.getVersion()).rejects.toThrow(ApiContractError);
  });

  it('returns nothing for a 204', async () => {
    const server = new FakeServer().on('POST', '/api/v1/auth/logout', () => ({ status: 204 }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: signedIn() });
    await expect(client.api.logout()).resolves.toBeUndefined();
  });
});

describe('[NFR-U04] errors the app can show and act on', () => {
  it('maps a server error to ApiRequestError with its code, message and details', async () => {
    const server = new FakeServer().on('POST', '/api/v1/auth/pin-login', () => ({
      status: 423,
      body: {
        code: 'ACCOUNT_LOCKED',
        message: 'This login is locked.',
        details: { lockedUntil: '2026-09-25T10:00:00.000Z' },
        correlationId: 'abc',
      },
    }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: PAIRED });
    const error = await client
      .signInWithPin({ staffId: STAFF_ID, pin: '1234' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 423,
      code: 'ACCOUNT_LOCKED',
      message: 'This login is locked.',
      details: { lockedUntil: '2026-09-25T10:00:00.000Z' },
    });
    expect(client.session).toBeUndefined();
  });

  it('maps a non-contract error page to a generic code', async () => {
    const server = new FakeServer().on('GET', '/api/v1/version', () => ({
      status: 502,
      body: '<html>Bad gateway</html>',
    }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch });
    await expect(client.api.getVersion()).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_502',
      message: 'The restaurant server had a problem. Try again.',
    });
    const notFound = new FakeServer().on('GET', '/api/v1/version', () => ({ status: 404 }));
    await expect(
      new ApiClient({ baseUrl: BASE, fetch: notFound.fetch }).api.getVersion(),
    ).rejects.toMatchObject({ code: 'HTTP_404', message: 'The request was not accepted.' });
  });

  it('reports an unreachable server, a timeout, and passes the caller’s cancellation on', async () => {
    const offline = new ApiClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(offline.api.getVersion()).rejects.toMatchObject({ reason: 'network' });

    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const slow = new ApiClient({ baseUrl: BASE, fetch: hanging, timeoutMs: 20 });
    const timeout = await slow.api.getVersion().catch((caught: unknown) => caught);
    expect(timeout).toBeInstanceOf(ApiUnavailableError);
    expect(timeout).toMatchObject({ reason: 'timeout' });

    const controller = new AbortController();
    const cancelled = slow.api.getVersion({ signal: controller.signal, timeoutMs: 5_000 });
    controller.abort(new Error('Left the screen'));
    await expect(cancelled).rejects.toThrow('Left the screen');
    await expect(slow.api.getVersion({ signal: controller.signal })).rejects.toThrow(
      'Left the screen',
    );
  });
});

describe('[AUTH-005] access tokens are refreshed, sessions end cleanly', () => {
  it('refreshes before the token expires, once for concurrent calls, and keeps the new tokens', async () => {
    const saved: StoredCredentials[] = [];
    const server = new FakeServer()
      .on('POST', '/api/v1/auth/refresh', () => ({
        status: 200,
        body: login('access-2', 'refresh-token-number-2'),
      }))
      .on('GET', '/api/v1/devices', () => ({ status: 200, body: DEVICES }));
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: signedIn(login('access-1', 'refresh-token-number-1', 0.2)),
      onCredentialsChange: (credentials) => saved.push(credentials),
    });

    await Promise.all([client.api.listDevices(), client.api.listDevices()]);

    expect(server.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
    expect(server.callsTo('POST', '/api/v1/auth/refresh')[0]?.body).toEqual({
      refreshToken: 'refresh-token-number-1',
    });
    for (const call of server.callsTo('GET', '/api/v1/devices')) {
      expect(call.headers.authorization).toBe('Bearer access-2');
    }
    expect(saved.at(-1)?.session?.refreshToken).toBe('refresh-token-number-2');
  });

  it('refreshes and retries once when the server says the token expired', async () => {
    const server = new FakeServer()
      .on(
        'GET',
        '/api/v1/devices',
        () => ({ status: 401, body: { code: 'TOKEN_EXPIRED', message: 'Renew.' } }),
        () => ({ status: 200, body: DEVICES }),
      )
      .on('POST', '/api/v1/auth/refresh', () => ({
        status: 200,
        body: login('access-2', 'refresh-token-number-2'),
      }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: signedIn() });
    await expect(client.api.listDevices()).resolves.toEqual(DEVICES);
    expect(
      server.callsTo('GET', '/api/v1/devices').map((call) => call.headers.authorization),
    ).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it('ends the session when the refresh is refused, and tells the app', async () => {
    const ended: string[] = [];
    const server = new FakeServer()
      .on('GET', '/api/v1/devices', () => ({
        status: 401,
        body: { code: 'TOKEN_EXPIRED', message: 'Renew.' },
      }))
      .on('POST', '/api/v1/auth/refresh', () => ({
        status: 401,
        body: { code: 'SESSION_EXPIRED', message: 'Signed out after inactivity.' },
      }));
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: signedIn(),
      onSessionEnded: (code) => ended.push(code),
    });
    await expect(client.api.listDevices()).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(ended).toEqual(['SESSION_EXPIRED']);
    expect(client.session).toBeUndefined();
    expect(client.device?.deviceId).toBe(DEVICE_ID);
    await expect(client.accessToken()).resolves.toBeUndefined();
  });

  it('ends the session when a call says it was revoked', async () => {
    const ended: string[] = [];
    const server = new FakeServer().on('GET', '/api/v1/devices', () => ({
      status: 401,
      body: { code: 'SESSION_REVOKED', message: 'Signed out.' },
    }));
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: signedIn(),
      onSessionEnded: (code) => ended.push(code),
    });
    await expect(client.api.listDevices()).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(ended).toEqual(['SESSION_REVOKED']);
  });

  it('signs in and out; sign-out always works locally', async () => {
    const server = new FakeServer()
      .on('POST', '/api/v1/auth/pin-login', () => ({
        status: 200,
        body: login('a', 'refresh-token-number-9'),
      }))
      .on('POST', '/api/v1/auth/logout', () => ({ status: 204 }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: PAIRED });
    await client.signInWithPin({ staffId: STAFF_ID, pin: '1234' });
    expect(client.session?.staff.displayName).toBe('Asha');
    await client.signOut();
    expect(client.session).toBeUndefined();
    await client.signOut();
    expect(server.callsTo('POST', '/api/v1/auth/logout')).toHaveLength(1);

    const offline = new ApiClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new TypeError('offline')),
      credentials: signedIn(),
    });
    await offline.signOut();
    expect(offline.session).toBeUndefined();
  });

  it('signs the Owner in with password and second factor', async () => {
    const server = new FakeServer().on('POST', '/api/v1/auth/owner-login', () => ({
      status: 200,
      body: login('owner-access', 'refresh-token-number-7'),
    }));
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch, credentials: PAIRED });
    await client.signInAsOwner({
      staffId: STAFF_ID,
      password: 'correct horse battery',
      secondFactor: { kind: 'TOTP', code: '123456' },
    });
    expect(client.session?.accessToken).toBe('owner-access');
  });

  it('uses the server clock from the Date header to judge expiry', async () => {
    const ahead = new Date(Date.now() + 10 * 60_000).toUTCString();
    const server = new FakeServer()
      .on('GET', '/api/v1/devices', () => ({
        status: 200,
        body: DEVICES,
        headers: { date: ahead },
      }))
      .on('POST', '/api/v1/auth/refresh', () => ({
        status: 200,
        body: login('access-2', 'refresh-token-number-2', 30),
      }));
    // Valid for 10 min 20 s by this device's clock, but only 20 s by the server's.
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: signedIn(login('access-1', 'refresh-token-number-1', 10 + 1 / 3)),
    });
    await client.api.listDevices();
    expect(server.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(0);
    await client.api.listDevices();
    expect(server.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
  });
});

describe('[AUTH-007] device pairing and device tokens', () => {
  it('pairs with a proof of the key, then gets a device token by signing a challenge', async () => {
    const { key } = await generateWebCryptoDeviceKey();
    const spki = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const valid = (message: string, signature: string) =>
      verify(
        'sha256',
        Buffer.from(message),
        { key: spki, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64'),
      );
    const code = 'ABCD-EFGH';
    const server = new FakeServer()
      .on('POST', '/api/v1/devices/pair', (call) => {
        const body = call.body as { proof: string; algorithm: string };
        expect(body.algorithm).toBe('ES256');
        expect(valid(pairingProofMessage(code), body.proof)).toBe(true);
        return {
          status: 201,
          body: {
            deviceId: DEVICE_ID,
            restaurantId: STAFF_ID,
            type: 'KDS',
            name: 'Tandoor screen',
            tableId: null,
            stationId: null,
            staffId: null,
          },
        };
      })
      .on('POST', '/api/v1/devices/challenge', () => ({
        status: 200,
        body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
      }))
      .on('POST', '/api/v1/devices/token', (call) => {
        const body = call.body as { signature: string; deviceId: string };
        expect(valid(deviceTokenMessage(DEVICE_ID, 'challenge-0123456789'), body.signature)).toBe(
          true,
        );
        return { status: 200, body: { deviceToken: 'device-9', expiresAt: inMinutes(60) } };
      });
    const client = new ApiClient({ baseUrl: BASE, fetch: server.fetch });

    const paired = await client.pair({ code, key, appVersion: '0.1.0' });

    expect(paired.name).toBe('Tandoor screen');
    expect(client.device).toMatchObject({ deviceId: DEVICE_ID, deviceToken: 'device-9' });
    expect(server.calls.map((call) => call.path)).toEqual([
      '/api/v1/devices/pair',
      '/api/v1/devices/challenge',
      '/api/v1/devices/token',
    ]);
    for (const call of server.calls) expect(call.headers['x-device-token']).toBeUndefined();
  });

  it('renews an expiring device token, and retries once when the server no longer knows it', async () => {
    const signer = {
      algorithm: 'ES256' as const,
      sign: vi.fn(() => Promise.resolve('c2lnbmF0dXJl')),
    };
    const server = new FakeServer()
      .on('POST', '/api/v1/devices/challenge', () => ({
        status: 200,
        body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
      }))
      .on(
        'POST',
        '/api/v1/devices/token',
        () => ({ status: 200, body: { deviceToken: 'device-2', expiresAt: inMinutes(60) } }),
        () => ({ status: 200, body: { deviceToken: 'device-3', expiresAt: inMinutes(60) } }),
      )
      .on(
        'GET',
        '/api/v1/auth/staff-tiles',
        () => ({ status: 200, body: TILES }),
        () => ({ status: 401, body: { code: 'DEVICE_NOT_RECOGNISED', message: 'Pair it.' } }),
        () => ({ status: 200, body: TILES }),
      );
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      signer,
      credentials: {
        device: {
          deviceId: DEVICE_ID,
          deviceToken: 'device-1',
          deviceTokenExpiresAt: inMinutes(0.5),
        },
      },
    });

    await client.api.listStaffTiles();
    await client.api.listStaffTiles();

    expect(
      server
        .callsTo('GET', '/api/v1/auth/staff-tiles')
        .map((call) => call.headers['x-device-token']),
    ).toEqual(['device-2', 'device-2', 'device-3']);
    expect(signer.sign).toHaveBeenCalledWith(deviceTokenMessage(DEVICE_ID, 'challenge-0123456789'));
  });

  it('forgets an unpaired device and tells the app', async () => {
    const revoked = vi.fn();
    const server = new FakeServer()
      .on('POST', '/api/v1/devices/challenge', () => ({
        status: 200,
        body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
      }))
      .on('POST', '/api/v1/devices/token', () => ({
        status: 401,
        body: { code: 'DEVICE_AUTH_FAILED', message: 'Pair it again.' },
      }));
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      signer: { algorithm: 'Ed25519', sign: () => Promise.resolve('c2ln') },
      credentials: signedIn(),
      onDeviceRevoked: revoked,
    });
    await expect(client.deviceToken(true)).rejects.toMatchObject({ code: 'DEVICE_AUTH_FAILED' });
    expect(revoked).toHaveBeenCalledOnce();
    expect(client.credentials).toEqual({});
    await expect(client.deviceToken()).rejects.toMatchObject({ code: 'DEVICE_NOT_PAIRED' });
  });

  it('uses the current device token without a key, and needs the key to renew it', async () => {
    const client = new ApiClient({ baseUrl: BASE, credentials: PAIRED });
    await expect(client.deviceToken()).resolves.toBe('device-1');
    await expect(client.deviceToken(true)).rejects.toMatchObject({ code: 'DEVICE_KEY_MISSING' });
    client.forgetDevice();
    expect(client.device).toBeUndefined();
  });
});

describe('[ORD-013] idempotency keys', () => {
  it('are random v4 UUIDs, even where randomUUID is missing', () => {
    const keys = new Set(Array.from({ length: 500 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(500);
    for (const key of keys) expect(key).toMatch(UUID);
  });
});

describe('the socket shares the client’s credentials', () => {
  it('builds the handshake and recovers from refusals', async () => {
    const ended: string[] = [];
    const revoked = vi.fn();
    const server = new FakeServer()
      .on('POST', '/api/v1/auth/refresh', () => ({
        status: 200,
        body: login('access-2', 'refresh-token-number-2'),
      }))
      .on('POST', '/api/v1/devices/challenge', () => ({
        status: 200,
        body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
      }))
      .on(
        'POST',
        '/api/v1/devices/token',
        () => ({ status: 200, body: { deviceToken: 'device-2', expiresAt: inMinutes(60) } }),
        () => ({ status: 429, body: { code: 'RATE_LIMITED', message: 'Wait.' } }),
        () => ({ status: 401, body: { code: 'DEVICE_AUTH_FAILED', message: 'Pair it again.' } }),
      );
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: signedIn(),
      signer: { algorithm: 'Ed25519', sign: () => Promise.resolve('c2ln') },
      onSessionEnded: (code) => ended.push(code),
      onDeviceRevoked: revoked,
    });

    await expect(client.handshake()).resolves.toEqual({
      deviceToken: 'device-1',
      accessToken: 'access-1',
    });
    await expect(client.recover('TOKEN_EXPIRED')).resolves.toBe('retry');
    expect(client.session?.accessToken).toBe('access-2');
    await expect(client.recover('DEVICE_NOT_RECOGNISED')).resolves.toBe('retry');
    expect(client.device?.deviceToken).toBe('device-2');
    await expect(client.recover('HANDSHAKE_INVALID')).resolves.toBe('stop');
    await expect(client.recover('SESSION_REVOKED')).resolves.toBe('retry');
    expect(ended).toEqual(['SESSION_REVOKED']);
    await expect(client.handshake()).resolves.toEqual({ deviceToken: 'device-2' });
    // Rate limited: try again later. Refused: the device is forgotten and the socket stops.
    await expect(client.recover('DEVICE_NOT_RECOGNISED')).resolves.toBe('retry');
    await expect(client.recover('DEVICE_NOT_RECOGNISED')).resolves.toBe('stop');
    expect(revoked).toHaveBeenCalledOnce();
  });

  it('keeps the last access token for the handshake while offline', async () => {
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new TypeError('offline')),
      credentials: signedIn(login('access-1', 'refresh-token-number-1', 0.1)),
    });
    await expect(client.handshake()).resolves.toEqual({
      deviceToken: 'device-1',
      accessToken: 'access-1',
    });
    await expect(client.recover('TOKEN_EXPIRED')).resolves.toBe('retry');
  });

  it('forgets what the server ended', () => {
    const ended: string[] = [];
    const revoked = vi.fn();
    const client = new ApiClient({
      baseUrl: BASE,
      credentials: signedIn(),
      onSessionEnded: (code) => ended.push(code),
      onDeviceRevoked: revoked,
    });
    client.ended('DEVICE_CHANGED');
    expect(client.session).toBeDefined();
    client.ended('SESSION_ENDED');
    expect(ended).toEqual(['SESSION_ENDED']);
    client.ended('DEVICE_REVOKED');
    expect(revoked).toHaveBeenCalledOnce();
    expect(client.credentials).toEqual({});
  });
});

describe('[SEC-006] device keys need WebCrypto', () => {
  it('explains that pairing needs a secure context where WebCrypto is missing', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(generateWebCryptoDeviceKey()).rejects.toThrow(DeviceKeyUnavailableError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
