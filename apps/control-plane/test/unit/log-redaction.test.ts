import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskedPath, maskedRequest, REQUEST_LOG_REDACTION } from '../../src/http/log-redaction.js';

/**
 * The request log (threat CP-I3, SEC-015): a digital bill's link and the development store's
 * grants are credentials in the address; neither is written, nor the headers that carry others.
 * The log is the Control Plane's own pino-http options, on a real server.
 */

const BILL_TOKEN = 'b'.repeat(43);
const GRANT = 'eyJvcCI6IkdFVCJ9.c2lnbmF0dXJl';
const lines: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const log = pinoHttp({ ...REQUEST_LOG_REDACTION }, stream);
  server = createServer((request, response) => {
    log(request, response);
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('[SEC-015] the request log', () => {
  it('writes no bill link, grant or credential header', async () => {
    await fetch(`${base}/v1/bills/${BILL_TOKEN}`);
    await fetch(`${base}/v1/object-store/${GRANT}?part=1`, { method: 'PUT', body: 'x' });
    await fetch(`${base}/v1/vendor/users`, { headers: { authorization: 'Bearer secret-token' } });
    await expect.poll(() => lines.length).toBe(3);
    const written = lines.join('\n');
    for (const secret of [BILL_TOKEN, GRANT, 'secret-token']) expect(written).not.toContain(secret);
    const urls = lines.map((line) => (JSON.parse(line) as { req: { url: string } }).req.url);
    expect(urls).toEqual([
      '/v1/bills/[REDACTED]',
      '/v1/object-store/[REDACTED]?part=1',
      '/v1/vendor/users',
    ]);
  });

  it('masks the path parameters that hold them, and leaves other addresses as they are', () => {
    expect(
      maskedRequest({ url: `/v1/bills/${BILL_TOKEN}`, params: { token: BILL_TOKEN, id: '7' } }),
    ).toEqual({ url: '/v1/bills/[REDACTED]', params: { token: '[REDACTED]', id: '7' } });
    expect(maskedPath('/v1/vendor/installations/7/cloud-backups')).toBe(
      '/v1/vendor/installations/7/cloud-backups',
    );
    expect(maskedPath('/v1/billsx/abc')).toBe('/v1/billsx/abc');
  });
});
