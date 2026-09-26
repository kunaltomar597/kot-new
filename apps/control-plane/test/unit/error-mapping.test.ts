import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CpError } from '../../src/errors/cp-error.js';
import { mapError } from '../../src/errors/cp-exception.filter.js';

describe('[SEC-004] Control Plane errors', () => {
  it('keeps the code, message and details of expected errors', () => {
    const mapped = mapError(new CpError(401, 'CLOCK_SKEW', 'Too far.', { serverTime: 'x' }), 'c1');
    expect(mapped).toEqual({
      status: 401,
      body: {
        code: 'CLOCK_SKEW',
        message: 'Too far.',
        details: { serverTime: 'x' },
        correlationId: 'c1',
      },
      unexpected: false,
    });
  });

  it('reports validation failures by path, without the values', () => {
    const result = z.object({ secret: z.number() }).safeParse({ secret: 'hunter2' });
    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(JSON.stringify(mapped.body)).not.toContain('hunter2');
    expect(mapped.body.details).toEqual({ issues: [expect.objectContaining({ path: 'secret' })] });
  });

  it('answers bad JSON, oversized bodies, unknown routes and surprises in the contract shape', () => {
    expect(mapError({ status: 400, type: 'entity.parse.failed' }).body.code).toBe('INVALID_JSON');
    expect(mapError({ status: 413, type: 'entity.too.large' }).body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(mapError(new NotFoundException()).body.code).toBe('NOT_FOUND');
    const surprise = mapError(new Error('database password is x'));
    expect(surprise).toMatchObject({ status: 500, unexpected: true });
    expect(surprise.body.message).not.toMatch(/password/);
  });
});
