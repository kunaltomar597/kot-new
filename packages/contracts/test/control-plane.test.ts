import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_ROUTES,
  EnrolmentCode,
  EnrolRequest,
  enrolmentProofMessage,
  HeartbeatRequest,
  NONCE_PATTERN,
  ReleaseInfo,
  SemVer,
  signedRequestMessage,
  UpdatesQuery,
} from '../src/control-plane/index.js';

const HEARTBEAT = {
  heartbeatId: '0199a0e0-0000-7000-8000-00000000b001',
  sentAt: '2026-09-26T10:00:00.000Z',
  components: [{ name: 'RESTAURANT_PC', version: '0.1.0' }],
  disk: { totalBytes: 512_000_000_000, freeBytes: 400_000_000_000 },
  auditChainHead: { sequence: 42, hash: 'a'.repeat(64) },
  devices: { POS: 1, KDS: 2 },
};

const RELEASE = {
  component: 'RESTAURANT_PC',
  channel: 'STABLE',
  version: '1.2.0',
  url: 'https://downloads.example.com/rp/1.2.0/setup.exe',
  sha256: 'b'.repeat(64),
  sizeBytes: 180_000_000,
  notes: null,
  publishedAt: '2026-09-26T10:00:00.000Z',
};

describe('[SEC-002] [ONB-003] enrolment contract (ADR-0012)', () => {
  it('accepts 16-character codes without look-alikes, in groups of four', () => {
    expect(EnrolmentCode.safeParse('ABCD-EFGH-JKLM-NP23').success).toBe(true);
    for (const bad of [
      'ABCD-EFGH-JKLM',
      'ABCD-EFGH-JKLM-NPQ0',
      'abcd-efgh-jklm-np23',
      'ABCDEFGHJKLMNP23',
    ]) {
      expect(EnrolmentCode.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('signs a versioned proof message and rejects unknown fields', () => {
    expect(enrolmentProofMessage('ABCD-EFGH-JKLM-NP23')).toBe('rp-cp-enrol:v1:ABCD-EFGH-JKLM-NP23');
    const request = { code: 'ABCD-EFGH-JKLM-NP23', publicKey: 'MCowBQYDK2VwAyEA', proof: 'c2ln' };
    expect(EnrolRequest.safeParse(request).success).toBe(true);
    expect(EnrolRequest.safeParse({ ...request, tenantId: 'x' }).success).toBe(false);
  });
});

describe('[SEC-002] signed requests (ADR-0012)', () => {
  it('builds the signed text from method, path with query, time, nonce and body digest', () => {
    expect(
      signedRequestMessage({
        method: 'get',
        path: '/v1/updates?version=1.2.0',
        timestamp: '1790380800000',
        nonce: 'bm9uY2Utbm9uY2Utbm9u',
        bodySha256: 'e'.repeat(64),
      }),
    ).toBe(
      'rp-cp-request:v1\nGET\n/v1/updates?version=1.2.0\n1790380800000\nbm9uY2Utbm9uY2Utbm9u\n' +
        'e'.repeat(64),
    );
    expect(NONCE_PATTERN.test('bm9uY2Utbm9uY2Utbm9u')).toBe(true);
    expect(NONCE_PATTERN.test('short')).toBe(false);
  });
});

describe('[VCP-005] [NFR-O03] heartbeat contract', () => {
  it('keeps fields a newer installation sends, so it is never refused', () => {
    const parsed = HeartbeatRequest.parse({ ...HEARTBEAT, backups: { lastSuccessAt: null } });
    expect(parsed).toMatchObject({ backups: { lastSuccessAt: null } });
  });

  it('needs at least one component and valid audit chain and disk values', () => {
    expect(HeartbeatRequest.safeParse({ ...HEARTBEAT, components: [] }).success).toBe(false);
    expect(
      HeartbeatRequest.safeParse({ ...HEARTBEAT, auditChainHead: { sequence: 1, hash: 'x' } })
        .success,
    ).toBe(false);
    expect(
      HeartbeatRequest.safeParse({ ...HEARTBEAT, disk: null, auditChainHead: null }).success,
    ).toBe(true);
  });
});

describe('[UPD-002] [UPD-007] releases', () => {
  it('accepts semantic versions only', () => {
    for (const good of ['0.1.0', '1.2.3', '10.0.0-beta.2', '1.0.0-rc-1']) {
      expect(SemVer.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['1.2', '01.2.3', '1.2.3+build.5', 'v1.2.3', '1.2.3-']) {
      expect(SemVer.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('downloads over HTTPS only, with a SHA-256 to check', () => {
    expect(ReleaseInfo.safeParse(RELEASE).success).toBe(true);
    expect(
      ReleaseInfo.safeParse({ ...RELEASE, url: 'http://downloads.example.com/x.exe' }).success,
    ).toBe(false);
    expect(ReleaseInfo.safeParse({ ...RELEASE, sha256: 'B'.repeat(64) }).success).toBe(false);
  });

  it('asks for updates of the Windows installer by default', () => {
    expect(UpdatesQuery.parse({ version: '1.0.0' })).toEqual({
      component: 'RESTAURANT_PC',
      version: '1.0.0',
    });
  });

  it('keeps every Control Plane route under /v1 with its access declared', () => {
    for (const route of CONTROL_PLANE_ROUTES) {
      expect(route.path.startsWith('/v1/')).toBe(true);
      expect(['INSTALLATION', 'PUBLIC']).toContain(route.capability);
    }
  });
});
