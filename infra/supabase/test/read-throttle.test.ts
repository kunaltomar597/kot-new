import { TABLE_TOKEN_HEADER } from '@rp/contracts/relay';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/http.js';
import { ReadThrottle } from '../src/read-throttle.js';

const LIMITS = { tableBurst: 4, tablePerSecond: 2, addressBurst: 6, addressPerSecond: 3 };

function read(token: string, address: string): Request {
  return new Request('https://relay.example/qr-menu', {
    headers: { [TABLE_TOKEN_HEADER]: token, 'x-forwarded-for': `10.0.0.9, ${address}` },
  });
}

function refusal(throttle: ReadThrottle, request: Request, now: number): HttpError | undefined {
  try {
    throttle.admit(request, now);
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
}

describe('[QR-008] reads of the relay are throttled (RELAY-D4)', () => {
  it('refuses a table that reads faster than its limit, with 429 and Retry-After', () => {
    const throttle = new ReadThrottle(LIMITS);
    for (let i = 0; i < 4; i += 1)
      expect(refusal(throttle, read('t1', '1.1.1.1'), 0)).toBeUndefined();
    const refused = refusal(throttle, read('t1', '1.1.1.1'), 0);
    expect(refused).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(refused?.headers['retry-after']).toBe('1');
    expect(refused?.details).toEqual({ retryAfterSeconds: 1 });
  });

  it('lets another table, and the same table a moment later, read', () => {
    const throttle = new ReadThrottle(LIMITS);
    for (let i = 0; i < 5; i += 1) refusal(throttle, read('t1', '1.1.1.1'), 0);
    expect(refusal(throttle, read('t2', '1.1.1.1'), 0)).toBeUndefined();
    expect(refusal(throttle, read('t1', '1.1.1.1'), 1_000)).toBeUndefined();
  });

  it('limits an address across its tables', () => {
    const throttle = new ReadThrottle(LIMITS);
    const results = Array.from({ length: 8 }, (_, i) =>
      refusal(throttle, read(`table-${String(i)}`, '2.2.2.2'), 0),
    );
    expect(results.filter((result) => result === undefined)).toHaveLength(6);
    expect(refusal(throttle, read('table-x', '3.3.3.3'), 0)).toBeUndefined();
  });

  it('counts the address the nearest proxy saw, not one the caller wrote', () => {
    const throttle = new ReadThrottle(LIMITS);
    for (let i = 0; i < 6; i += 1) {
      const request = new Request('https://relay.example/qr-menu', {
        headers: {
          [TABLE_TOKEN_HEADER]: `t${String(i)}`,
          'x-forwarded-for': `${String(i)}.9.9.9, 4.4.4.4`,
        },
      });
      refusal(throttle, request, 0);
    }
    const seventh = new Request('https://relay.example/qr-menu', {
      headers: { [TABLE_TOKEN_HEADER]: 'again', 'x-forwarded-for': '99.9.9.9, 4.4.4.4' },
    });
    expect(refusal(throttle, seventh, 0)).toMatchObject({ status: 429 });
  });
});
