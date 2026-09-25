import { describe, expect, it } from 'vitest';
import {
  type AuditHashFields,
  computeAuditHash,
  GENESIS_HASH,
  normalizeAuditJson,
} from '../../src/audit/audit-hash.js';

const base: AuditHashFields = {
  seq: 1,
  id: '0190a9f2-7c3e-7a55-8f0e-5a1b2c3d4e5f',
  restaurantId: '0190a9f2-7c3e-7a55-8f0e-000000000001',
  businessDate: '2026-09-25',
  occurredAt: '2026-09-25T10:00:00.000Z',
  action: 'DISCOUNT_APPLIED',
  actorId: null,
  approverId: null,
  deviceId: null,
  entityType: 'invoice',
  entityId: null,
  before: { total: 10_000 },
  after: { total: 9_000 },
  reason: 'Regular guest',
  correlationId: 'abc',
  prevHash: GENESIS_HASH,
};

describe('[AUD-003] audit hash', () => {
  it('is a 64-character lowercase SHA-256 hex digest and deterministic', () => {
    const hash = computeAuditHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeAuditHash({ ...base })).toBe(hash);
  });

  it('does not depend on the key order of before/after values', () => {
    const reordered = { ...base, after: JSON.parse('{"b":2,"a":1}') as unknown };
    const ordered = { ...base, after: { a: 1, b: 2 } };
    expect(computeAuditHash(reordered)).toBe(computeAuditHash(ordered));
  });

  it.each(Object.keys(base) as (keyof AuditHashFields)[])('changes when %s changes', (key) => {
    const changed: Record<string, unknown> = { ...base };
    const value = base[key];
    changed[key] =
      typeof value === 'number'
        ? value + 1
        : typeof value === 'string'
          ? `${value}x`
          : value === null
            ? 'set'
            : { changed: true };
    expect(computeAuditHash(changed as unknown as AuditHashFields)).not.toBe(
      computeAuditHash(base),
    );
  });

  it('chains: the previous hash is part of the input', () => {
    const first = computeAuditHash(base);
    const second = computeAuditHash({ ...base, seq: 2, prevHash: first });
    const forged = computeAuditHash({ ...base, seq: 2, prevHash: GENESIS_HASH });
    expect(second).not.toBe(forged);
  });
});

describe('[AUD-002] normalizeAuditJson', () => {
  it('stores "no value" as null and dates as ISO strings', () => {
    expect(normalizeAuditJson(undefined)).toBeNull();
    expect(normalizeAuditJson(null)).toBeNull();
    expect(
      normalizeAuditJson({ at: new Date('2026-09-25T01:02:03.004Z'), gone: undefined }),
    ).toEqual({ at: '2026-09-25T01:02:03.004Z' });
  });

  it('rejects values JSON cannot hold, so nothing is silently dropped from the audit', () => {
    expect(() => normalizeAuditJson({ amount: Number.NaN })).toThrow();
  });
});
