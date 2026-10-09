import type { INestApplication } from '@nestjs/common';
import { ApiError, FirstRunResponse, FirstRunStatus } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { FirstRunService } from '../../src/onboarding/first-run.service.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/** P7-07b: a fresh install gets its restaurant and Owner on the restaurant PC (ONB-001). */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
const server = () => request(httpServer(app));

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[ONB-001] [ONB-004] the first run', () => {
  it('creates the restaurant, the built-in roles, an invoice series and the Owner, once', async () => {
    expect(FirstRunStatus.parse((await server().get('/api/v1/first-run')).body)).toEqual({
      needed: true,
      pinLength: 4,
    });
    const sixDigits = await server()
      .post('/api/v1/first-run')
      .send({ restaurantName: 'Spice Route', ownerName: 'Asha', ownerPin: '482915' });
    expect(sixDigits.status).toBe(400);
    // Pairing waits for the restaurant.
    expect((await server().post('/api/v1/devices/pairing-codes/bootstrap')).status).toBe(409);
    const bad = await server()
      .post('/api/v1/first-run')
      .send({ restaurantName: 'Spice Route', ownerName: 'Asha', ownerPin: '12' });
    expect(bad.status).toBe(400);
    // [PC-S5] The Owner's PIN may not be one guessed first.
    const easy = await server()
      .post('/api/v1/first-run')
      .send({ restaurantName: 'Spice Route', ownerName: 'Asha', ownerPin: '1234' });
    expect([easy.status, ApiError.parse(easy.body).code]).toEqual([422, 'PIN_TOO_EASY']);
    expect(await prisma.restaurant.count()).toBe(0);

    const created = await server()
      .post('/api/v1/first-run')
      .send({ restaurantName: ' Spice Route ', ownerName: 'Asha Rao', ownerPin: '4829' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { restaurantId, ownerId } = FirstRunResponse.parse(created.body);
    const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
    expect(restaurant.displayName).toBe('Spice Route');
    expect(
      (await prisma.role.findMany({ where: { restaurantId } })).map((role) => role.key).sort(),
    ).toEqual(['CASHIER', 'KITCHEN', 'MANAGER', 'OWNER', 'WAITER']);
    expect(await prisma.invoiceSeries.count({ where: { restaurantId, isDefault: true } })).toBe(1);
    const owner = await prisma.staff.findUniqueOrThrow({
      where: { id: ownerId },
      include: { role: true, credentials: true },
    });
    expect(owner).toMatchObject({ displayName: 'Asha Rao', role: { baseRole: 'OWNER' } });
    expect(owner.credentials.map((credential) => credential.kind)).toEqual(['PIN']);
    expect(owner.credentials[0]?.secretHash).not.toContain('4829');
    expect(
      await prisma.auditLog.count({ where: { action: 'RESTAURANT_CREATED', actorId: ownerId } }),
    ).toBe(1);

    // Only once.
    const again = await server()
      .post('/api/v1/first-run')
      .send({ restaurantName: 'Another', ownerName: 'Someone', ownerPin: '5038' });
    expect([again.status, ApiError.parse(again.body).code]).toEqual([403, 'FIRST_RUN_CLOSED']);
    expect(FirstRunStatus.parse((await server().get('/api/v1/first-run')).body)).toEqual({
      needed: false,
      pinLength: 4,
    });
    // The PC can now pair itself as the first POS.
    expect((await server().post('/api/v1/devices/pairing-codes/bootstrap')).status).toBe(201);
  });

  it('is refused from anywhere but the restaurant PC', async () => {
    await expect(
      app
        .get(FirstRunService)
        .complete({ restaurantName: 'X', ownerName: 'Y', ownerPin: '1234' }, false),
    ).rejects.toMatchObject({ status: 403, code: 'FIRST_RUN_CLOSED' });
  });
});
