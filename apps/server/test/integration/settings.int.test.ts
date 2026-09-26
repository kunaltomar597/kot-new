import type { INestApplication } from '@nestjs/common';
import { ApiError, type LoginResponse, SettingsResponse, SettingView } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthSettingsService } from '../../src/auth/auth-settings.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let owner: LoginResponse;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

function list(login: LoginResponse) {
  return request(httpServer(app)).get('/api/v1/settings').set(as(login));
}

function put(login: LoginResponse, key: string, body: Record<string, unknown>) {
  return request(httpServer(app)).put(`/api/v1/settings/${key}`).set(as(login)).send(body);
}

/** As if the Owner had just confirmed password + second factor (the flow is in auth-owner tests). */
async function stepUp(login: LoginResponse): Promise<void> {
  await prisma.session.update({
    where: { id: login.session.id },
    data: { secondFactorAt: new Date() },
  });
}

describe('[MGR-007] [UPD-010] settings registry', () => {
  it('lists every setting with its default and who may change it', async () => {
    const response = await list(manager);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { settings } = SettingsResponse.parse(response.body);
    const byKey = new Map(settings.map((setting) => [setting.key, setting]));
    expect(byKey.get('kds.ageAmberMinutes')).toMatchObject({
      value: 10,
      defaultValue: 10,
      isDefault: true,
      scope: 'RESTAURANT',
      editable: true,
      unit: 'minutes',
      updatedAt: null,
    });
    // The Owner's settings and the vendor's are visible to a manager, not editable.
    expect(byKey.get('billing.priceMode')).toMatchObject({
      value: 'TAX_EXCLUSIVE',
      editable: false,
    });
    expect(byKey.get('licence.graceDays')).toMatchObject({ scope: 'VENDOR', editable: false });
    expect(settings.length).toBeGreaterThan(50);
  });

  it('is for managers and the Owner only', async () => {
    const waiter = await signIn(app, kit, 'WAITER');
    expect((await list(waiter)).status).toBe(403);
    expect((await put(waiter, 'kds.ageAmberMinutes', { value: 12 })).status).toBe(403);
  });

  it('[AUD-001] changes a value with an audit entry and a SettingsChanged event', async () => {
    const response = await put(manager, 'kds.ageAmberMinutes', {
      value: 12,
      reason: 'Tandoor tickets take longer',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(SettingView.parse(response.body)).toMatchObject({ value: 12, isDefault: false });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'SETTING_CHANGED' },
      orderBy: { chainSeq: 'desc' },
    });
    expect(audit).toMatchObject({
      before: { key: 'kds.ageAmberMinutes', value: 10 },
      after: { key: 'kds.ageAmberMinutes', value: 12 },
      reason: 'Tandoor tickets take longer',
      actorId: kit.staff.MANAGER,
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'SettingsChanged' },
      orderBy: { writeOrder: 'desc' },
    });
    expect(event.payload).toMatchObject({ payload: { keys: ['kds.ageAmberMinutes'] } });

    // The same value again changes nothing and records nothing.
    const again = await put(manager, 'kds.ageAmberMinutes', { value: 12 });
    expect(again.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'SETTING_CHANGED' } })).toBe(1);

    const listed = SettingsResponse.parse((await list(manager)).body).settings.find(
      (setting) => setting.key === 'kds.ageAmberMinutes',
    );
    expect(listed?.updatedAt).not.toBeNull();
  });

  it('refuses values the catalogue does not allow, and conflicting settings', async () => {
    const invalid = await put(manager, 'kds.ageAmberMinutes', { value: 'ten' });
    expect([invalid.status, codeOf(invalid)]).toEqual([422, 'SETTING_INVALID']);
    const conflict = await put(manager, 'kds.ageRedMinutes', { value: 11 }); // amber is 12
    expect([conflict.status, codeOf(conflict)]).toEqual([422, 'SETTING_CONFLICT']);
    expect((await put(manager, 'kds.nothing', { value: 1 })).status).toBe(404);
    expect((await put(manager, 'Not A Key', { value: 1 })).status).toBe(400);
    expect((await put(manager, 'kds.ageAmberMinutes', { value: 12, extra: true })).status).toBe(
      400,
    );
  });

  it('[UPD-010] keeps vendor-controlled settings read-only here', async () => {
    const response = await put(owner, 'licence.graceDays', { value: 30 });
    expect([response.status, codeOf(response)]).toEqual([403, 'SETTING_VENDOR_CONTROLLED']);
  });

  it('[AUTH-006] [BILL-004] leaves tax, invoice and data settings to the Owner with a fresh second factor', async () => {
    const byManager = await put(manager, 'billing.priceMode', { value: 'TAX_INCLUSIVE' });
    expect([byManager.status, codeOf(byManager)]).toEqual([403, 'FORBIDDEN']);
    const stale = await put(owner, 'billing.priceMode', { value: 'TAX_INCLUSIVE' });
    expect([stale.status, codeOf(stale)]).toEqual([403, 'SECOND_FACTOR_REQUIRED']);

    await stepUp(owner);
    const changed = await put(owner, 'billing.priceMode', { value: 'TAX_INCLUSIVE' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(SettingView.parse(changed.body).value).toBe('TAX_INCLUSIVE');

    // A nullable setting goes back to null.
    expect((await put(owner, 'backups.secondLocation', { value: 'E:\\Backups' })).status).toBe(200);
    const cleared = await put(owner, 'backups.secondLocation', { value: null });
    expect(SettingView.parse(cleared.body)).toMatchObject({ value: null, isDefault: true });
  });

  it('[AUTH-003] applies authentication settings at once', async () => {
    expect((await put(manager, 'auth.lockoutMaxFailures', { value: 7 })).status).toBe(200);
    const auth = await app.get(AuthSettingsService).get(kit.restaurantId);
    expect(auth.lockoutMaxFailures).toBe(7);
  });

  it('falls back to the default when a stored value no longer validates', async () => {
    await prisma.setting.update({
      where: { restaurantId_key: { restaurantId: kit.restaurantId, key: 'kds.ageAmberMinutes' } },
      data: { value: 'broken' },
    });
    app.get(AuthSettingsService).invalidate();
    const listed = SettingsResponse.parse((await list(manager)).body).settings.find(
      (setting) => setting.key === 'kds.ageAmberMinutes',
    );
    expect(listed?.value).toBe(10);
  });
});
