import { Agent, request as httpRequest } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ApiError, DEVICE_TOKEN_HEADER } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeviceTokenAuthenticator } from '../../src/auth/device-token.authenticator.js';
import { authHeaders, type AuthKit, createAuthKit } from '../helpers/auth-kit.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * PC-D1: the server checks the device token before it reads a body, so a host on the LAN without
 * a paired device cannot make it read and parse megabytes: only paired devices send more than a
 * small body (pairing, a device token and the first run all fit in 16 KB).
 */

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;

const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
/** A photo upload's body of about `bytes` bytes. */
const photoOf = (bytes: number) => ({ contentBase64: 'A'.repeat(bytes) });

/**
 * A POST on a kept-alive connection, as browsers and the apps send it: the server answers a body
 * it refuses before the body is all sent, and discards the rest as it comes. (Supertest asks for
 * the connection to be closed, so the server closes it after answering, and the rest of a large
 * body is then reset.)
 */
const keptAlive = new Agent({ keepAlive: true });
function post(path: string, body: object): Promise<{ status: number; code: string }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, appUrl(app)), {
      method: 'POST',
      agent: keptAlive,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    });
    outgoing.on('response', (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolve({
          status: incoming.statusCode ?? 0,
          code: ApiError.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).code,
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(text);
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  kit = await createAuthKit(app);
});

afterAll(async () => {
  keptAlive.destroy();
  await app.close();
  await database.drop();
});

describe('[SEC-004] [SEC-003] bodies only from paired devices', () => {
  it('reads no more than a small body from a caller without a paired device, uploads included', async () => {
    expect(await post('/api/v1/photos', photoOf(1_200_000))).toEqual({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(await post('/api/v1/menu/ai-imports', photoOf(100_000))).toEqual({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    // The same body from a paired device is read, and the guard asks for a person.
    const paired = await server()
      .post('/api/v1/photos')
      .set(authHeaders(kit.deviceId))
      .send(photoOf(100_000));
    expect([paired.status, codeOf(paired)]).toEqual([401, 'UNAUTHENTICATED']);
    // A small body without a device is still read: pairing works.
    const pairing = await server()
      .post('/api/v1/devices/pair')
      .send({ code: 'WRONG-CODE', name: 'Tablet' });
    expect(pairing.status).not.toBe(413);
  });

  it('answers before the body arrives', async () => {
    const url = new URL('/api/v1/photos', appUrl(app));
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(7_000_000) },
      });
      outgoing.on('response', (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
        outgoing.destroy();
      });
      outgoing.on('error', reject);
      // One byte of the seven million it announced; the rest never comes.
      outgoing.write('{');
    });
    expect(status).toBe(413);
  });

  it('tells a device whose token no longer verifies to renew it, without reading a large body', async () => {
    const expired = await server()
      .post('/api/v1/photos')
      .set(DEVICE_TOKEN_HEADER, 'not-a-token')
      .send(photoOf(100_000));
    expect([expired.status, codeOf(expired)]).toEqual([401, 'DEVICE_NOT_RECOGNISED']);
  });

  it('checks the device once per request', async () => {
    const check = vi.spyOn(app.get(DeviceTokenAuthenticator), 'authenticate');
    try {
      await server().get('/api/v1/staff').set(authHeaders(kit.deviceId));
      await server().post('/api/v1/photos').send(photoOf(10));
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      check.mockRestore();
    }
  });
});
