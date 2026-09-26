import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  INSTALLATION_HEADERS,
  enrolmentProofMessage,
  signedRequestMessage,
} from '@rp/contracts/control-plane';
import { describe, expect, it } from 'vitest';
import type { SecretName, SecretStore } from '../../src/auth/secret-store.js';
import { ConfigError, loadConfig } from '../../src/config/app-config.js';
import { ControlPlaneClient, ControlPlaneError } from '../../src/cloud/control-plane-client.js';
import { normaliseEnrolmentCode } from '../../src/cloud/enrolment.js';
import { installationKey, type InstallationKey } from '../../src/cloud/installation-key.js';

const INSTALLATION = '0199a0e0-0000-7000-8000-00000000c001';
const SERVER_TIME = '2026-09-26T10:00:00.000Z';

class FixedSecrets implements SecretStore {
  constructor(private readonly fill: number) {}
  get(_name: SecretName): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(32, this.fill));
  }
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake Control Plane: answers each call in turn and records it. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init: init ?? {} });
    const answer = answers.shift();
    if (answer === undefined) throw new Error('No more answers');
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const HEARTBEAT = {
  heartbeatId: '0199a0e0-0000-7000-8000-00000000b001',
  sentAt: SERVER_TIME,
  components: [{ name: 'RESTAURANT_PC', version: '1.0.0' }],
  disk: null,
  auditChainHead: null,
  devices: {},
};
const ANSWER = {
  receivedAt: SERVER_TIME,
  serverTime: SERVER_TIME,
  nextHeartbeatSeconds: 300,
  update: null,
};

function headerOf(call: Call | undefined, name: string): string {
  const value = (call?.init.headers as Record<string, string> | undefined)?.[name];
  if (value === undefined) throw new Error(`No ${name} header`);
  return value;
}

/** Verifies a recorded request the way the Control Plane does (ADR-0012). */
function signatureValid(call: Call | undefined, key: InstallationKey): boolean {
  const url = new URL(call?.url ?? '');
  const body = typeof call?.init.body === 'string' ? call.init.body : '';
  const message = signedRequestMessage({
    method: call?.init.method ?? 'GET',
    path: `${url.pathname}${url.search}`,
    timestamp: headerOf(call, INSTALLATION_HEADERS.timestamp),
    nonce: headerOf(call, INSTALLATION_HEADERS.nonce),
    bodySha256: createHash('sha256').update(body).digest('hex'),
  });
  return verify(
    null,
    Buffer.from(message),
    createPublicKey({ key: Buffer.from(key.publicKeySpki, 'base64'), format: 'der', type: 'spki' }),
    Buffer.from(headerOf(call, INSTALLATION_HEADERS.signature), 'base64'),
  );
}

describe('[SEC-002] installation key (ADR-0012)', () => {
  it('is the same Ed25519 key for the same secret, and another for another secret', async () => {
    const first = await installationKey(new FixedSecrets(1));
    const again = await installationKey(new FixedSecrets(1));
    const other = await installationKey(new FixedSecrets(2));
    expect(first.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(again.publicKeySpki).toBe(first.publicKeySpki);
    expect(other.publicKeySpki).not.toBe(first.publicKeySpki);
  });
});

describe('[SEC-002] [VCP-005] Control Plane client', () => {
  it('enrols with a proof of its key', async () => {
    const key = await installationKey(new FixedSecrets(3));
    const fake = fakeFetch(
      json(201, {
        installationId: INSTALLATION,
        tenantId: INSTALLATION,
        name: 'Main PC',
        channel: 'STABLE',
        enrolledAt: SERVER_TIME,
      }),
    );
    const client = new ControlPlaneClient({
      baseUrl: 'https://cp.example.com',
      key,
      fetch: fake.fetch,
    });
    const enrolled = await client.enrol('ABCD-EFGH-JKLM-NP23');
    expect(enrolled.installationId).toBe(INSTALLATION);
    const [call] = fake.calls;
    expect(call?.url).toBe('https://cp.example.com/v1/enrolments');
    expect(call?.init.redirect).toBe('error');
    const sent = call?.init.body;
    const body = JSON.parse(typeof sent === 'string' ? sent : '{}') as {
      publicKey: string;
      proof: string;
    };
    expect(body.publicKey).toBe(key.publicKeySpki);
    expect(
      verify(
        null,
        Buffer.from(enrolmentProofMessage('ABCD-EFGH-JKLM-NP23')),
        createPublicKey({
          key: Buffer.from(key.publicKeySpki, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(body.proof, 'base64'),
      ),
    ).toBe(true);
  });

  it('signs each request over method, path, time, nonce and body', async () => {
    const key = await installationKey(new FixedSecrets(4));
    const fake = fakeFetch(json(200, ANSWER), json(200, { channel: 'STABLE', update: null }));
    const client = new ControlPlaneClient({
      baseUrl: 'https://cp.example.com',
      key,
      fetch: fake.fetch,
    });
    await client.heartbeat(INSTALLATION, HEARTBEAT);
    await client.updates(INSTALLATION, '1.0.0');
    expect(fake.calls.map((call) => call.url)).toEqual([
      'https://cp.example.com/v1/heartbeats',
      'https://cp.example.com/v1/updates?version=1.0.0',
    ]);
    for (const call of fake.calls) {
      expect(signatureValid(call, key)).toBe(true);
      expect(headerOf(call, INSTALLATION_HEADERS.installation)).toBe(INSTALLATION);
    }
    // A fresh nonce every time.
    expect(headerOf(fake.calls[0], INSTALLATION_HEADERS.nonce)).not.toBe(
      headerOf(fake.calls[1], INSTALLATION_HEADERS.nonce),
    );
  });

  it('[LIC-007] corrects its clock after CLOCK_SKEW and tries once more', async () => {
    const key = await installationKey(new FixedSecrets(5));
    const now = Date.parse(SERVER_TIME) - 10 * 60_000; // this PC is 10 minutes behind
    const fake = fakeFetch(
      json(401, { code: 'CLOCK_SKEW', message: 'Too far.', details: { serverTime: SERVER_TIME } }),
      json(200, ANSWER),
    );
    const client = new ControlPlaneClient({
      baseUrl: 'https://cp.example.com',
      key,
      fetch: fake.fetch,
      now: () => now,
    });
    await client.heartbeat(INSTALLATION, HEARTBEAT);
    expect(client.clockOffsetMs).toBe(10 * 60_000);
    expect(Number(headerOf(fake.calls[1], INSTALLATION_HEADERS.timestamp))).toBe(
      Date.parse(SERVER_TIME),
    );
    expect(signatureValid(fake.calls[1], key)).toBe(true);
  });

  it('reports failures with a code: refused, unreachable, unexpected', async () => {
    const key = await installationKey(new FixedSecrets(6));
    const fake = fakeFetch(
      json(403, { code: 'INSTALLATION_REVOKED', message: 'Revoked.' }),
      new TypeError('fetch failed'),
      new Response('<html>Bad gateway</html>', { status: 502 }),
      json(200, { unexpected: true }),
    );
    const client = new ControlPlaneClient({
      baseUrl: 'https://cp.example.com',
      key,
      fetch: fake.fetch,
    });
    const codes: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await client.heartbeat(INSTALLATION, HEARTBEAT).catch((error: unknown) => {
        codes.push(error instanceof ControlPlaneError ? error.code : 'other');
      });
    }
    expect(codes).toEqual(['INSTALLATION_REVOKED', 'UNREACHABLE', 'HTTP_502', 'INVALID_RESPONSE']);
  });
});

describe('[ONB-003] enrolment codes typed by people', () => {
  it('accepts spaces, dashes and lower case, and refuses anything else', () => {
    expect(normaliseEnrolmentCode('abcd efgh jklm np23')).toBe('ABCD-EFGH-JKLM-NP23');
    expect(normaliseEnrolmentCode(' ABCDEFGHJKLMNP23 ')).toBe('ABCD-EFGH-JKLM-NP23');
    expect(() => normaliseEnrolmentCode('ABCD-EFGH-JKLM')).toThrow(/16 letters/);
    expect(() => normaliseEnrolmentCode('ABCD-EFGH-JKLM-NP20')).toThrow(/16 letters/);
  });
});

describe('[SEC-001] Control Plane address', () => {
  const base = { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/rp' };

  it('is the service origin, without a trailing slash', () => {
    expect(
      loadConfig({ ...base, RP_CONTROL_PLANE_URL: 'https://cp.example.com/' }).controlPlaneUrl,
    ).toBe('https://cp.example.com');
    expect(() =>
      loadConfig({ ...base, RP_CONTROL_PLANE_URL: 'https://cp.example.com/api' }),
    ).toThrow(/origin/);
    expect(() => loadConfig({ ...base, RP_CONTROL_PLANE_URL: 'ftp://cp.example.com' })).toThrow(
      ConfigError,
    );
    expect(loadConfig(base).controlPlaneUrl).toBeUndefined();
  });

  it('must use HTTPS in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        RP_CONTROL_PLANE_URL: 'http://cp.example.com',
      }),
    ).toThrow(/https/);
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        RP_CONTROL_PLANE_URL: 'https://cp.example.com',
      }).controlPlaneUrl,
    ).toBe('https://cp.example.com');
  });
});
