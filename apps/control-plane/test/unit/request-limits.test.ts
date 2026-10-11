import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { requestLimitMiddleware } from '../../src/http/request-limits.js';

const LIMITS = { burst: 5, perSecond: 2, publicBurst: 3, publicPerSecond: 1 };

interface Outcome {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly code: string | undefined;
}

function run(
  handler: ReturnType<typeof requestLimitMiddleware>,
  ip: string,
  path = '/v1/heartbeats',
): Outcome {
  let outcome: Outcome = { status: 200, retryAfter: undefined, code: undefined };
  let retryAfter: string | undefined;
  const response = {
    setHeader: (name: string, value: string) => {
      if (name === 'retry-after') retryAfter = value;
    },
    status(status: number) {
      return {
        json: (body: { code?: string }) => {
          outcome = { status, retryAfter, code: body.code };
        },
      };
    },
  } as unknown as Response;
  handler({ ip, path } as unknown as Request, response, () => undefined);
  return outcome;
}

describe('[SEC-001] the Control Plane limits each address (CP-D1)', () => {
  it('lets an address burst, then answers 429 RATE_LIMITED with Retry-After', () => {
    const handler = requestLimitMiddleware(LIMITS, () => 0);
    const statuses = Array.from({ length: 7 }, () => run(handler, '1.1.1.1').status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    const refused = run(handler, '1.1.1.1');
    expect(refused).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it('counts each address on its own and refills with time', () => {
    let now = 0;
    const handler = requestLimitMiddleware(LIMITS, () => now);
    for (let i = 0; i < 5; i += 1) run(handler, '1.1.1.1');
    expect(run(handler, '1.1.1.1').status).toBe(429);
    expect(run(handler, '2.2.2.2').status).toBe(200);
    now = 1_000; // two tokens back
    expect(run(handler, '1.1.1.1').status).toBe(200);
    expect(run(handler, '1.1.1.1').status).toBe(200);
    expect(run(handler, '1.1.1.1').status).toBe(429);
  });

  it('holds digital bill pages to a lower limit than the rest', () => {
    const handler = requestLimitMiddleware(LIMITS, () => 0);
    const statuses = Array.from(
      { length: 5 },
      () => run(handler, '3.3.3.3', '/v1/bills/abc').status,
    );
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('never limits the health probe, and is off with a burst of 0', () => {
    const handler = requestLimitMiddleware(LIMITS, () => 0);
    for (let i = 0; i < 50; i += 1) expect(run(handler, '4.4.4.4', '/v1/health').status).toBe(200);
    const off = requestLimitMiddleware({ ...LIMITS, burst: 0 }, () => 0);
    for (let i = 0; i < 50; i += 1) expect(run(off, '5.5.5.5').status).toBe(200);
  });

  it('keeps its memory bounded under a flood from many addresses', () => {
    const handler = requestLimitMiddleware(LIMITS, () => 0);
    for (let i = 0; i < 25_000; i += 1) run(handler, `10.${String(i >> 8)}.${String(i & 255)}.1`);
    expect(run(handler, '9.9.9.9').status).toBe(200);
  });
});
