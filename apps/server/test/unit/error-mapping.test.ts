import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ApiError } from '@rp/contracts';
import { DomainError, type DomainErrorCode } from '@rp/domain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors/app-error.js';
import { mapError } from '../../src/errors/error-mapping.js';

const ALL_DOMAIN_CODES: DomainErrorCode[] = [
  'INVALID_AMOUNT',
  'INVALID_RATE',
  'INVALID_QUANTITY',
  'INVALID_ARGUMENT',
  'DISCOUNT_EXCEEDS_AMOUNT',
  'UNKNOWN_TAX_GROUP',
  'INVALID_TAX_GROUP',
  'INVALID_TRANSITION',
  'INVALID_SELECTION',
  'INVOICE_NUMBER_TOO_LONG',
  'INVALID_INVOICE_SERIES',
  'INVALID_DATE',
  'INVALID_TIME',
];

describe('[NFR-U04] error mapping to the ApiError contract', () => {
  it('maps every domain error code to a 4xx with the domain message', () => {
    for (const code of ALL_DOMAIN_CODES) {
      const mapped = mapError(new DomainError(code, `Problem ${code}`, { field: 'x' }), 'c-1');
      expect(mapped.status).toBeGreaterThanOrEqual(400);
      expect(mapped.status).toBeLessThan(500);
      expect(mapped.unexpected).toBe(false);
      expect(mapped.body).toEqual({
        code,
        message: `Problem ${code}`,
        details: { field: 'x' },
        correlationId: 'c-1',
      });
      expect(ApiError.safeParse(mapped.body).success).toBe(true);
    }
    expect(mapError(new DomainError('INVALID_TRANSITION', 'no')).status).toBe(409);
  });

  it('maps validation errors to 400 with field paths', () => {
    const result = z
      .object({ lines: z.array(z.object({ quantity: z.int().positive() })) })
      .safeParse({
        lines: [{ quantity: 0 }],
      });
    expect(result.success).toBe(false);
    if (result.success) return;
    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe('VALIDATION_FAILED');
    expect(mapped.body.details).toEqual({
      issues: [expect.objectContaining({ path: 'lines.0.quantity' })],
    });
  });

  it('maps application and HTTP errors', () => {
    expect(mapError(AppError.notFound('Table T9'))).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'Table T9 was not found' },
    });
    expect(mapError(AppError.conflict('TABLE_OCCUPIED', 'Table is occupied')).status).toBe(409);
    expect(mapError(new AppError(503, 'PRINTER_OFFLINE', 'Printer offline')).unexpected).toBe(true);
    expect(mapError(new NotFoundException()).body).toMatchObject({ code: 'NOT_FOUND' });
    expect(mapError(new ForbiddenException()).body).toEqual({
      code: 'FORBIDDEN',
      message: 'Forbidden',
    });
    expect(mapError(new BadRequestException(['a is required', 'b is required'])).body.message).toBe(
      'a is required; b is required',
    );
    expect(mapError(new HttpException({ other: 1 }, 418))).toMatchObject({
      status: 418,
      body: { code: 'HTTP_418', message: 'The request could not be completed.' },
    });
    expect(mapError(new HttpException({}, 429)).body.message).toMatch(/Too many attempts/);
  });

  it('maps body-parser failures', () => {
    expect(
      mapError(Object.assign(new Error('bad'), { status: 400, type: 'entity.parse.failed' })),
    ).toMatchObject({
      status: 400,
      body: { code: 'INVALID_BODY' },
    });
    expect(
      mapError(Object.assign(new Error('big'), { status: 413, type: 'entity.too.large' })),
    ).toMatchObject({
      status: 413,
      body: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('[SEC-004] hides internal details of unexpected errors', () => {
    const mapped = mapError(new Error('connection string postgres://secret@host leaked'), 'c-9');
    expect(mapped.status).toBe(500);
    expect(mapped.unexpected).toBe(true);
    expect(mapped.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(mapped.body)).not.toContain('secret');
    expect(mapped.body.correlationId).toBe('c-9');
    expect(mapError('a thrown string').status).toBe(500);
  });
});
