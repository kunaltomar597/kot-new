import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  InvoiceSeriesListResponse,
  InvoiceSeriesView,
  type LoginResponse,
  RestaurantProfile,
  TaxGroupListResponse,
  TaxGroupView,
} from '@rp/contracts';
import { calendarDateOf, financialYearOf } from '@rp/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let owner: LoginResponse;
let waiter: LoginResponse;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
  waiter = await signIn(app, kit, 'WAITER');
  // As if the Owner had just confirmed password + second factor (that flow is in auth tests).
  await prisma.session.update({
    where: { id: owner.session.id },
    data: { secondFactorAt: new Date() },
  });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse, deviceId = kit.deviceId) =>
  authHeaders(deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

const PROFILE = {
  displayName: 'Demo Dhaba',
  contact: { phone: '+91 98765 43210', email: 'hello@demodhaba.in' },
  businessHours: [
    { day: 'MON', start: '12:00', end: '15:30' },
    { day: 'MON', start: '19:00', end: '23:30' },
    { day: 'SAT', start: '18:00', end: '01:30' },
  ],
  logoPhotoId: null,
  businessDayCutoff: '04:00',
};

const LEGAL = {
  legalName: 'Demo Foods Private Limited',
  address: { line1: '1 Demo Road', city: 'Pune', pincode: '411001' },
  stateCode: '27',
  gstin: '27AAPFU0939F1ZV',
  fssaiNumber: '11521999000123',
};

const GST5 = {
  name: 'GST 5 %',
  sacCode: '996331',
  components: [
    { code: 'CGST', rateBp: 250 },
    { code: 'SGST', rateBp: 250 },
  ],
};

const SERIES = {
  name: 'Dine-in',
  prefix: 'INV',
  includeFinancialYear: true,
  separator: '/',
  sequencePadding: 6,
};

async function latestAudit(action: string) {
  return prisma.auditLog.findFirstOrThrow({ where: { action }, orderBy: { chainSeq: 'desc' } });
}

async function setupEvents(part: string): Promise<number> {
  return prisma.outboxEvent.count({
    where: { eventType: 'RestaurantChanged', payload: { path: ['payload', 'part'], equals: part } },
  });
}

describe('[ONB-004] [BILL-002] restaurant profile', () => {
  it('is readable by any paired device, before anyone signs in', async () => {
    const response = await server().get('/api/v1/restaurant').set(authHeaders(kit.deviceId));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RestaurantProfile.parse(response.body)).toMatchObject({
      id: kit.restaurantId,
      displayName: 'Auth Dhaba',
      legalName: null,
      gstin: null,
      contact: { phone: null, email: null },
      businessHours: [],
      timeZone: 'Asia/Kolkata',
      businessDayCutoff: '04:00',
    });
    expect((await server().get('/api/v1/restaurant')).status).toBe(401);
  });

  it('[AUD-001] lets a manager change the profile, audited and announced', async () => {
    const response = await server()
      .put('/api/v1/restaurant/profile')
      .set(as(manager))
      .send({ ...PROFILE, reason: 'Opening week' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RestaurantProfile.parse(response.body)).toMatchObject({
      displayName: 'Demo Dhaba',
      contact: PROFILE.contact,
      businessHours: PROFILE.businessHours,
    });

    const audit = await latestAudit('RESTAURANT_PROFILE_CHANGED');
    expect(audit).toMatchObject({
      actorId: kit.staff.MANAGER,
      reason: 'Opening week',
      before: { displayName: 'Auth Dhaba', phone: null },
      after: { displayName: 'Demo Dhaba', phone: '+91 98765 43210' },
    });
    expect(await setupEvents('PROFILE')).toBe(1);

    // The same values again change nothing and record nothing.
    const again = await server().put('/api/v1/restaurant/profile').set(as(manager)).send(PROFILE);
    expect(again.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'RESTAURANT_PROFILE_CHANGED' } })).toBe(
      1,
    );
    expect(await setupEvents('PROFILE')).toBe(1);
  });

  it('is not for waiters or kitchen staff', async () => {
    const response = await server().put('/api/v1/restaurant/profile').set(as(waiter)).send(PROFILE);
    expect([response.status, codeOf(response)]).toEqual([403, 'FORBIDDEN']);
  });

  it('takes as the logo only a photo from the photo store', async () => {
    const missing = await server()
      .put('/api/v1/restaurant/profile')
      .set(as(manager))
      .send({ ...PROFILE, logoPhotoId: '01926a3e-0000-7000-8000-000000000001' });
    expect([missing.status, codeOf(missing)]).toEqual([422, 'LOGO_PHOTO_NOT_FOUND']);

    const photo = await prisma.photo.create({
      data: {
        restaurantId: kit.restaurantId,
        storageKey: 'logo/demo.webp',
        mimeType: 'image/webp',
        width: 480,
        height: 480,
        bytes: 12_000,
        sha256: 'a'.repeat(64),
      },
    });
    const response = await server()
      .put('/api/v1/restaurant/profile')
      .set(as(manager))
      .send({ ...PROFILE, logoPhotoId: photo.id });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RestaurantProfile.parse(response.body).logoPhotoId).toBe(photo.id);
    // A photo in use as the logo cannot be removed by photo clean-up (P1-04).
    await expect(prisma.photo.delete({ where: { id: photo.id } })).rejects.toThrow();
  });

  it('[AUTH-006] leaves the invoice particulars to the Owner with a fresh second factor', async () => {
    const byManager = await server().put('/api/v1/restaurant/legal').set(as(manager)).send(LEGAL);
    expect([byManager.status, codeOf(byManager)]).toEqual([403, 'FORBIDDEN']);

    const byOwner = await server().put('/api/v1/restaurant/legal').set(as(owner)).send(LEGAL);
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
    expect(RestaurantProfile.parse(byOwner.body)).toMatchObject({
      legalName: LEGAL.legalName,
      address: LEGAL.address,
      stateCode: '27',
      stateName: 'Maharashtra',
      gstin: LEGAL.gstin,
      fssaiNumber: LEGAL.fssaiNumber,
    });
    const audit = await latestAudit('RESTAURANT_LEGAL_CHANGED');
    expect(audit).toMatchObject({
      actorId: kit.staff.OWNER,
      before: { gstin: null },
      after: { gstin: LEGAL.gstin },
    });
    expect(await setupEvents('LEGAL')).toBe(1);

    // Without the second factor the Owner is asked for it.
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: null },
    });
    const stale = await server().put('/api/v1/restaurant/legal').set(as(owner)).send(LEGAL);
    expect([stale.status, codeOf(stale)]).toEqual([403, 'SECOND_FACTOR_REQUIRED']);
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
  });

  it('[BILL-002] refuses a mistyped GSTIN or one from another state', async () => {
    for (const legal of [
      { ...LEGAL, gstin: '27AAPFU0939F1ZW' }, // check character
      { ...LEGAL, stateCode: '29' }, // a Maharashtra GSTIN for Karnataka
      { ...LEGAL, gstin: '27aapfu0939f1zv' }, // not in canonical form
    ]) {
      const response = await server().put('/api/v1/restaurant/legal').set(as(owner)).send(legal);
      expect([response.status, codeOf(response)], JSON.stringify(legal)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
  });
});

describe('[BILL-004] tax groups', () => {
  let gst5: TaxGroupView;

  it('are added by the Owner only, with the rates as data', async () => {
    const byManager = await server().post('/api/v1/tax-groups').set(as(manager)).send(GST5);
    expect(byManager.status).toBe(403);

    const response = await server().post('/api/v1/tax-groups').set(as(owner)).send(GST5);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    gst5 = TaxGroupView.parse(response.body);
    expect(gst5).toMatchObject({
      name: 'GST 5 %',
      sacCode: '996331',
      components: GST5.components,
      totalRateBp: 500,
      itemCount: 0,
      archivedAt: null,
    });
    expect(await latestAudit('TAX_GROUP_CREATED')).toMatchObject({
      entityId: gst5.id,
      after: { name: 'GST 5 %', sacCode: '996331', components: GST5.components },
    });

    // Anyone signed in reads them (menu editing assigns items to groups).
    const listed = await server().get('/api/v1/tax-groups').set(as(waiter));
    expect(listed.status).toBe(200);
    expect(TaxGroupListResponse.parse(listed.body).taxGroups.map((group) => group.id)).toEqual([
      gst5.id,
    ]);
  });

  it('refuses a second active group with the same name', async () => {
    const response = await server()
      .post('/api/v1/tax-groups')
      .set(as(owner))
      .send({ ...GST5, name: 'gst 5 %' });
    expect([response.status, codeOf(response)]).toEqual([409, 'TAX_GROUP_NAME_TAKEN']);
  });

  it('[AUD-001] changes rates with before and after in the audit log', async () => {
    const eighteen = {
      name: 'GST 18 %',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 900 },
        { code: 'SGST', rateBp: 900 },
      ],
      reason: 'Outdoor catering rate',
    };
    const response = await server()
      .put(`/api/v1/tax-groups/${gst5.id}`)
      .set(as(owner))
      .send(eighteen);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(TaxGroupView.parse(response.body)).toMatchObject({ totalRateBp: 1_800 });
    expect(await latestAudit('TAX_GROUP_CHANGED')).toMatchObject({
      before: { name: 'GST 5 %', components: GST5.components },
      after: { name: 'GST 18 %', components: eighteen.components },
      reason: 'Outdoor catering rate',
    });

    const again = await server().put(`/api/v1/tax-groups/${gst5.id}`).set(as(owner)).send(eighteen);
    expect(again.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'TAX_GROUP_CHANGED' } })).toBe(1);
    expect(await prisma.taxComponent.count({ where: { taxGroupId: gst5.id } })).toBe(2);
  });

  it('archives a group only when no menu item uses it, and never deletes it', async () => {
    const category = await prisma.category.create({
      data: { restaurantId: kit.restaurantId, name: 'Starters' },
    });
    const station = await prisma.station.create({
      data: { restaurantId: kit.restaurantId, name: 'Kitchen' },
    });
    const item = await prisma.item.create({
      data: {
        restaurantId: kit.restaurantId,
        categoryId: category.id,
        name: 'Paneer Tikka',
        basePrice: 24_000,
        taxGroupId: gst5.id,
        foodType: 'VEG',
        stationId: station.id,
      },
    });
    const archive = () =>
      server()
        .post(`/api/v1/tax-groups/${gst5.id}/archive`)
        .set(as(owner))
        .send({ reason: 'Replaced by the new rate card' });

    const inUse = await archive();
    expect([inUse.status, codeOf(inUse)]).toEqual([409, 'TAX_GROUP_IN_USE']);
    const listed = TaxGroupListResponse.parse(
      (await server().get('/api/v1/tax-groups').set(as(owner))).body,
    );
    expect(listed.taxGroups[0]?.itemCount).toBe(1);

    await prisma.item.update({ where: { id: item.id }, data: { archivedAt: new Date() } });
    const archived = await archive();
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(TaxGroupView.parse(archived.body).archivedAt).not.toBeNull();
    expect(await latestAudit('TAX_GROUP_ARCHIVED')).toMatchObject({
      reason: 'Replaced by the new rate card',
    });
    // Archiving again is harmless; an archived group cannot be changed.
    expect((await archive()).status).toBe(200);
    const change = await server().put(`/api/v1/tax-groups/${gst5.id}`).set(as(owner)).send(GST5);
    expect([change.status, codeOf(change)]).toEqual([409, 'TAX_GROUP_ARCHIVED']);
    // Its name is free again for a new group.
    expect((await server().post('/api/v1/tax-groups').set(as(owner)).send(GST5)).status).toBe(201);
    expect(await prisma.taxGroup.count()).toBe(2);
  });

  it('answers 404 for an unknown group and 400 for a malformed id', async () => {
    const unknown = await server()
      .put('/api/v1/tax-groups/01926a3e-0000-7000-8000-000000000002')
      .set(as(owner))
      .send(GST5);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'TAX_GROUP_NOT_FOUND']);
    expect((await server().put('/api/v1/tax-groups/42').set(as(owner)).send(GST5)).status).toBe(
      400,
    );
  });
});

describe('[BILL-003] invoice series', () => {
  let dineIn: InvoiceSeriesView;
  let takeaway: InvoiceSeriesView;

  const create = (body: Record<string, unknown>) =>
    server().post('/api/v1/invoice-series').set(as(owner)).send(body);

  it('makes the first series the default and shows how its numbers look', async () => {
    const byManager = await server().post('/api/v1/invoice-series').set(as(manager)).send(SERIES);
    expect(byManager.status).toBe(403);

    const first = await create(SERIES);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    dineIn = InvoiceSeriesView.parse(first.body);
    const year = financialYearOf(calendarDateOf(new Date())).shortLabel;
    expect(dineIn).toMatchObject({
      isDefault: true,
      example: `INV/${year}/000001`,
      invoiceCount: 0,
    });

    const second = await create({
      ...SERIES,
      name: 'Takeaway',
      prefix: 'TA',
      includeFinancialYear: false,
      separator: '-',
      sequencePadding: 5,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    takeaway = InvoiceSeriesView.parse(second.body);
    expect(takeaway).toMatchObject({ isDefault: false, example: 'TA-00001' });
    expect(await latestAudit('INVOICE_SERIES_CREATED')).toMatchObject({ entityId: takeaway.id });
    expect(await setupEvents('INVOICE_SERIES')).toBe(2);
  });

  it('refuses a prefix already in use and numbers longer than 16 characters', async () => {
    const taken = await create({ ...SERIES, name: 'Again' });
    expect([taken.status, codeOf(taken)]).toEqual([409, 'INVOICE_SERIES_PREFIX_TAKEN']);
    const tooLong = await create({ ...SERIES, prefix: 'LONGPREFIX' });
    expect([tooLong.status, codeOf(tooLong)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('fixes the format once an invoice has been issued, but allows a new name', async () => {
    await prisma.invoice.create({
      data: {
        restaurantId: kit.restaurantId,
        businessDate: new Date('2026-09-26'),
        invoiceDate: new Date('2026-09-26'),
        financialYear: '2026-27',
        seriesId: dineIn.id,
        sequence: 1,
        invoiceNumber: 'INV/26-27/000001',
        priceMode: 'TAX_EXCLUSIVE',
        subtotal: 10_000,
        taxTotal: 500,
        grandTotal: 10_500,
        issuedById: kit.staff.CASHIER,
      },
    });
    const update = (body: Record<string, unknown>) =>
      server().put(`/api/v1/invoice-series/${dineIn.id}`).set(as(owner)).send(body);

    const reformat = await update({ ...SERIES, prefix: 'DI' });
    expect([reformat.status, codeOf(reformat)]).toEqual([409, 'INVOICE_SERIES_FORMAT_FIXED']);
    const separator = await update({ ...SERIES, separator: '-' });
    expect([separator.status, codeOf(separator)]).toEqual([409, 'INVOICE_SERIES_FORMAT_FIXED']);

    const renamed = await update({ ...SERIES, name: 'Restaurant' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(InvoiceSeriesView.parse(renamed.body)).toMatchObject({
      name: 'Restaurant',
      prefix: 'INV',
      invoiceCount: 1,
    });
    expect(await latestAudit('INVOICE_SERIES_CHANGED')).toMatchObject({
      before: { name: 'Dine-in' },
      after: { name: 'Restaurant' },
    });

    // A series without invoices may still change its format.
    const takeawayUpdate = await server()
      .put(`/api/v1/invoice-series/${takeaway.id}`)
      .set(as(owner))
      .send({ ...SERIES, name: 'Takeaway', prefix: 'TK' });
    expect(takeawayUpdate.status, JSON.stringify(takeawayUpdate.body)).toBe(200);
    takeaway = InvoiceSeriesView.parse(takeawayUpdate.body);
    expect(takeaway.prefix).toBe('TK');
  });

  it('keeps exactly one default series, which cannot be archived', async () => {
    const archive = (id: string) =>
      server()
        .post(`/api/v1/invoice-series/${id}/archive`)
        .set(as(owner))
        .send({ reason: 'One series for everything' });

    const refused = await archive(dineIn.id);
    expect([refused.status, codeOf(refused)]).toEqual([409, 'INVOICE_SERIES_IS_DEFAULT']);

    const made = await server()
      .post(`/api/v1/invoice-series/${takeaway.id}/default`)
      .set(as(owner));
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(InvoiceSeriesView.parse(made.body).isDefault).toBe(true);
    expect(await latestAudit('INVOICE_SERIES_DEFAULT_CHANGED')).toMatchObject({
      before: { defaultSeriesId: dineIn.id },
      after: { defaultSeriesId: takeaway.id },
    });

    const archived = await archive(dineIn.id);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(InvoiceSeriesView.parse(archived.body)).toMatchObject({
      invoiceCount: 1,
      isDefault: false,
    });

    const listed = InvoiceSeriesListResponse.parse(
      (await server().get('/api/v1/invoice-series').set(as(waiter))).body,
    ).invoiceSeries;
    expect(listed.filter((series) => series.isDefault).map((series) => series.id)).toEqual([
      takeaway.id,
    ]);

    // An archived series is done: not the default again, not changed, and its prefix stays taken.
    const again = await server().post(`/api/v1/invoice-series/${dineIn.id}/default`).set(as(owner));
    expect([again.status, codeOf(again)]).toEqual([409, 'INVOICE_SERIES_ARCHIVED']);
    const change = await server()
      .put(`/api/v1/invoice-series/${dineIn.id}`)
      .set(as(owner))
      .send(SERIES);
    expect([change.status, codeOf(change)]).toEqual([409, 'INVOICE_SERIES_ARCHIVED']);
    expect((await create({ ...SERIES, name: 'Reuse' })).status).toBe(409);
  });
});

describe('[NFR-L03] business-day cut-off', () => {
  /** The next instant after now at `hh:mm` UTC. */
  function nextUtc(hours: number, minutes: number): Date {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes),
    );
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  it('refuses a new cut-off that would move the business date at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 03:00 IST: under the 04:00 cut-off it is still yesterday's business day.
      vi.setSystemTime(nextUtc(21, 30));
      // Credentials issued at the new time, so nothing expires because the clock moved.
      const device = await addDevice(app, kit);
      const lateManager = await signIn(app, kit, 'MANAGER', device);
      const put = (cutoff: string) =>
        server()
          .put('/api/v1/restaurant/profile')
          .set(as(lateManager, device))
          .send({ ...PROFILE, businessDayCutoff: cutoff });

      const moved = await put('02:00');
      expect([moved.status, codeOf(moved)]).toEqual([409, 'CUTOFF_WOULD_MOVE_BUSINESS_DATE']);
      const kept = await put('05:00');
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(RestaurantProfile.parse(kept.body).businessDayCutoff).toBe('05:00');
    } finally {
      vi.useRealTimers();
    }
  });
});
