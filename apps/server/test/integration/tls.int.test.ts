import { X509Certificate } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { type ConnectionOptions, connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  PairingCodeResponse,
  REALTIME_NAMESPACE,
  TlsCaResponse,
  VersionResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpsOptionsFor } from '../../src/app.factory.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { createCertificateAuthority, isIssuedBy } from '../../src/tls/certificates.js';
import { TlsService } from '../../src/tls/tls.service.js';
import {
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signIn,
} from '../helpers/auth-kit.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { api, appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * P0-15 acceptance (ADR-0011): the server serves HTTPS and WSS with the certificate its own CA
 * issued; a client that pinned that CA connects, a client trusting another CA is rejected.
 */

const DAY = 86_400_000;

let database: TestDatabase;
let app: INestApplication;
let tls: TlsService;
let kit: AuthKit;
let url: string;
let port: number;
/** The installation's CA as a device pins it (PEM) and its fingerprint. */
let ca: string;
let caSha256: string;
/** A CA of another installation (or an attacker's). */
let otherCa: string;

interface HttpsResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function httpsGet(path: string, options: RequestOptions = {}): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      { host: '127.0.0.1', port, path, method: 'GET', ...options },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** A raw TLS handshake with the server; rejects the way the client refuses the server. */
function handshake(options: ConnectionOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ...options }, () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** The error code a failed handshake ends with. */
async function refusal(options: ConnectionOptions): Promise<string | undefined> {
  try {
    const socket = await handshake(options);
    socket.destroy();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

/** The server certificate new connections get, as a client that pinned the CA sees it. */
async function servedCertificate(): Promise<{ fingerprint: string; protocol: string | null }> {
  const socket = await handshake({ ca });
  try {
    expect(socket.authorized).toBe(true);
    return {
      fingerprint: socket.getPeerCertificate().fingerprint256,
      protocol: socket.getProtocol(),
    };
  } finally {
    socket.destroy();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, config: { tls: true }, listen: true });
  tls = app.get(TlsService);
  url = appUrl(app);
  port = Number(new URL(url).port);
  const published = tls.ca();
  if (published === undefined) throw new Error('TLS is not enabled');
  ca = published.certificate;
  caSha256 = published.sha256;
  otherCa = (await createCertificateAuthority()).certificatePem;
  kit = await createAuthKit(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[SEC-001] [SEC-010] HTTPS with the installation CA', () => {
  it('serves HTTPS on its port; a client that pinned the CA connects', async () => {
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const response = await httpsGet('/api/v1/version', { ca });
    expect(response.status).toBe(200);
    expect(VersionResponse.parse(JSON.parse(response.body)).apiVersion).toBe('v1');
    // By default the connection uses TLS 1.3.
    expect((await servedCertificate()).protocol).toBe('TLSv1.3');
  });

  it('is rejected by a client that trusts another CA, or only the public ones', async () => {
    await expect(httpsGet('/api/v1/version', { ca: otherCa })).rejects.toMatchObject({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    expect(await refusal({ ca: otherCa })).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(await refusal({})).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('covers the server names only: localhost yes, any other host name no', async () => {
    const local = await handshake({ ca, servername: 'localhost' });
    expect(local.authorized).toBe(true);
    local.destroy();
    expect(await refusal({ ca, servername: 'pos.example.com' })).toBe(
      'ERR_TLS_CERT_ALTNAME_INVALID',
    );
  });

  it('accepts TLS 1.2 and refuses older protocols', async () => {
    const twelve = await handshake({ ca, maxVersion: 'TLSv1.2' });
    expect(twelve.getProtocol()).toBe('TLSv1.2');
    twelve.destroy();
    const old = await refusal({
      ca,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.1',
      // Lets this client offer TLS 1.1 at all, so the refusal is the server's.
      ciphers: 'DEFAULT@SECLEVEL=0',
    });
    // The server's "protocol version" alert: it refuses, not the client.
    expect(old).toBe('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
  });
});

describe('[SEC-001] [SEC-010] WSS with the installation CA', () => {
  it('lets a device that pinned the CA open the real-time socket, and no other', async () => {
    const auth = { deviceToken: deviceTokenOf(kit.deviceId) };
    const client = await RealtimeTestClient.connect(url, auth, { ca });
    try {
      expect(client.syncs[0]?.fullRefresh).toBe(true);
    } finally {
      client.close();
    }
    const refused = await RealtimeTestClient.refused(url, auth, REALTIME_NAMESPACE, {
      ca: otherCa,
    });
    expect(refused.code).toBeUndefined();
    expect(refused.message).toMatch(/websocket error/i);
  });
});

describe('[SEC-010] pinning the CA while pairing', () => {
  it('puts the CA fingerprint in the pairing code and its QR payload', async () => {
    const manager = await signIn(app, kit, 'MANAGER');
    const response = await api(app)
      .post('/api/v1/devices/pairing-codes')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ type: 'WAITER_PHONE', name: 'Ravi phone' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const code = PairingCodeResponse.parse(response.body);
    expect(code.caSha256).toBe(caSha256);
    expect(JSON.parse(code.qrPayload)).toEqual({ v: 1, code: code.code, ca: caSha256 });
  });

  it('publishes the CA without credentials; its fingerprint is the one in the QR code', async () => {
    // A new device reads this before it trusts the server and keeps the CA only if its
    // fingerprint matches the QR code (the app's side is P2-01). No token is needed.
    const response = await httpsGet('/api/v1/tls/ca', { ca });
    expect(response.status).toBe(200);
    const published = TlsCaResponse.parse(JSON.parse(response.body));
    expect(new X509Certificate(published.certificate).fingerprint256).toBe(caSha256);
    expect(published).toEqual({
      certificate: ca,
      sha256: caSha256,
      expiresAt: new Date(new X509Certificate(ca).validTo).toISOString(),
    });
    expect(new Date(published.expiresAt).getTime() - Date.now()).toBeGreaterThan(3_600 * DAY);
  });

  it('offers the CA as a file for browsers to install', async () => {
    const response = await httpsGet('/ca.crt', { ca });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/x-x509-ca-cert/);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="restaurant-ca.crt"',
    );
    expect(new X509Certificate(response.body).fingerprint256).toBe(caSha256);
  });
});

describe('[SEC-001] certificate rotation', () => {
  it('swaps a renewed certificate into the running server; the pinned CA stays the same', async () => {
    const before = await servedCertificate();

    // A renewal while the PC's clock was a year ahead: the running server switches to the new
    // certificate at once, which is not valid yet at the real time.
    expect(await tls.renew(new Date(Date.now() + 380 * DAY))).toBe(true);
    expect(await refusal({ ca })).toBe('CERT_NOT_YET_VALID');

    // Back at the real time, the next check replaces it with one valid now.
    expect(await tls.renew()).toBe(true);
    const after = await servedCertificate();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(tls.ca()?.sha256).toBe(caSha256);
    expect(await tls.renew()).toBe(false);

    // A restart serves the stored certificate from the same CA.
    const config = app.get<AppConfig>(APP_CONFIG);
    const restarted = await httpsOptionsFor(config);
    expect(new X509Certificate(restarted.cert as string).fingerprint256).toBe(after.fingerprint);
    expect(isIssuedBy(restarted.cert as string, ca)).toBe(true);
  });
});

describe('[SEC-001] without TLS (development)', () => {
  it('has no CA to offer and no fingerprint in pairing codes', async () => {
    const own = await createTestDatabase();
    const plain = await createTestApp({ databaseUrl: own.url });
    try {
      const response = await request(httpServer(plain)).get('/api/v1/tls/ca');
      expect(response.status).toBe(404);
      expect(ApiError.parse(response.body).code).toBe('TLS_NOT_ENABLED');
      expect((await request(httpServer(plain)).get('/ca.crt')).status).toBe(404);
      expect(plain.get(TlsService).caFingerprint()).toBeNull();
    } finally {
      await plain.close();
      await own.drop();
    }
  });
});
