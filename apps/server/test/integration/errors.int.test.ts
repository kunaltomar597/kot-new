import { Body, Controller, Get, HttpCode, type INestApplication, Post } from '@nestjs/common';
import { ApiError, SubmitOrderRequest } from '@rp/contracts';
import { DomainError } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { ZodValidationPipe } from '../../src/validation/zod-validation.pipe.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

@Controller('probe')
class ProbeController {
  @Get('domain')
  domain(): never {
    throw new DomainError('INVALID_TRANSITION', 'OrderItem: cannot SERVE from VOIDED', {
      from: 'VOIDED',
    });
  }

  @Get('missing')
  missing(): never {
    throw AppError.notFound('Table T9');
  }

  @Get('crash')
  crash(): never {
    throw new Error('database password is hunter2');
  }

  @Post('orders')
  @HttpCode(200)
  order(@Body(new ZodValidationPipe(SubmitOrderRequest)) body: SubmitOrderRequest): {
    lines: number;
  } {
    return { lines: body.lines.length };
  }
}

describe('[SEC-004] errors reach clients as ApiError bodies', () => {
  let database: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp({ databaseUrl: database.url, controllers: [ProbeController] });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  function expectApiError(body: unknown, code: string): ApiError {
    const parsed = ApiError.parse(body);
    expect(parsed.code).toBe(code);
    expect(parsed.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    return parsed;
  }

  it('maps domain errors to 409/422 with details', async () => {
    const response = await request(httpServer(app)).get('/api/v1/probe/domain').expect(409);
    const body = expectApiError(response.body, 'INVALID_TRANSITION');
    expect(body.details).toEqual({ from: 'VOIDED' });
    expect(response.headers['x-correlation-id']).toBe(body.correlationId);
  });

  it('maps application errors', async () => {
    const response = await request(httpServer(app)).get('/api/v1/probe/missing').expect(404);
    expect(expectApiError(response.body, 'NOT_FOUND').message).toBe('Table T9 was not found');
  });

  it('never leaks internal error messages', async () => {
    const response = await request(httpServer(app)).get('/api/v1/probe/crash').expect(500);
    expectApiError(response.body, 'INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('[ORD-014] validates bodies against contracts and rejects client prices', async () => {
    const valid = {
      idempotencyKey: '01999999-0000-7000-8000-000000000001',
      source: 'POS',
      orderType: 'TAKEAWAY',
      lines: [
        {
          clientLineId: '01999999-0000-7000-8000-000000000002',
          itemId: '01999999-0000-7000-8000-000000000003',
          quantity: 2,
        },
      ],
    };
    await request(httpServer(app))
      .post('/api/v1/probe/orders')
      .send(valid)
      .expect(200, { lines: 1 });

    const withPrice = { ...valid, lines: [{ ...valid.lines[0], unitPrice: 1 }] };
    const response = await request(httpServer(app))
      .post('/api/v1/probe/orders')
      .send(withPrice)
      .expect(400);
    expectApiError(response.body, 'VALIDATION_FAILED');
  });

  it('rejects malformed JSON and unknown routes with the same shape', async () => {
    const malformed = await request(httpServer(app))
      .post('/api/v1/probe/orders')
      .set('content-type', 'application/json')
      .send('{"source": ')
      .expect(400);
    expectApiError(malformed.body, 'INVALID_BODY');

    const unknown = await request(httpServer(app)).get('/api/v1/does-not-exist').expect(404);
    expectApiError(unknown.body, 'NOT_FOUND');
  });

  it('limits request body size', async () => {
    const response = await request(httpServer(app))
      .post('/api/v1/probe/orders')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ orderNote: 'x'.repeat(1_200_000) }))
      .expect(413);
    expectApiError(response.body, 'PAYLOAD_TOO_LARGE');
  });
});
