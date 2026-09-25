import { SubmitOrderRequest } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { newId } from '../../src/common/ids.js';
import {
  redactionPaths,
  resolveCorrelationId,
  SENSITIVE_KEYS,
} from '../../src/logging/correlation.js';
import { ZodValidationPipe } from '../../src/validation/zod-validation.pipe.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('[NFR-O01] correlation IDs', () => {
  it('keeps a safe client-supplied id', () => {
    expect(resolveCorrelationId('tablet-T7:0042')).toBe('tablet-T7:0042');
    expect(resolveCorrelationId(['first', 'second'])).toBe('first');
  });

  it('replaces missing, unsafe or oversized ids with a new UUID', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID);
    expect(resolveCorrelationId('bad id with spaces')).toMatch(UUID);
    expect(resolveCorrelationId('<script>')).toMatch(UUID);
    expect(resolveCorrelationId('x'.repeat(65))).toMatch(UUID);
    expect(resolveCorrelationId(undefined)).not.toBe(resolveCorrelationId(undefined));
  });
});

describe('[SEC-015] log redaction', () => {
  it('redacts credentials at several depths', () => {
    const paths = redactionPaths();
    for (const key of ['pin', 'password', 'refreshToken', 'overrideToken']) {
      expect(SENSITIVE_KEYS).toContain(key);
      expect(paths).toContain(key);
      expect(paths).toContain(`*.${key}`);
      expect(paths).toContain(`*.*.${key}`);
    }
    expect(paths).toContain('req.headers.authorization');
  });
});

describe('[SEC-004] request validation pipe', () => {
  const pipe = new ZodValidationPipe(SubmitOrderRequest);

  it('returns the parsed value', () => {
    const parsed = pipe.transform({
      idempotencyKey: newId(),
      source: 'POS',
      orderType: 'TAKEAWAY',
      lines: [{ clientLineId: newId(), itemId: newId(), quantity: 1 }],
    });
    expect(parsed.lines[0]?.modifiers).toEqual([]);
  });

  it('throws the ZodError for invalid input', () => {
    expect(() => pipe.transform({ source: 'POS' })).toThrow(ZodError);
  });
});

describe('ids', () => {
  it('creates time-ordered UUIDv7 values', () => {
    const first = newId();
    const second = newId();
    expect(first).toMatch(UUID);
    expect(first[14]).toBe('7');
    expect(first < second).toBe(true);
  });
});
