import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ApiError, DataExportResponse, DataExportView } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DataExportService } from '../../src/lifecycle/data-export.service.js';
import { LicenceAgentService } from '../../src/licensing/licence-agent.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { seedDesignCapacity } from '../performance/design-capacity.js';

/**
 * The full data export (P7-06c, DATA-010): every table as JSON lines and CSV, the invoice register
 * and the invoices as PDFs, for the Owner at any time, also while the licence restricts ordering
 * (LIC-005); no credentials or secret hashes.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
const folder = mkdtempSync(join(tmpdir(), 'rp-export-'));

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  await seedDesignCapacity(app, kit, { lastDay: '2024-04-01', days: 2, ordersPerDay: 6 });
}, 120_000);

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[DATA-010] the full data export', () => {
  it('writes every table, the invoice register and the invoices, even when the licence is restricted', async () => {
    // LIC-005: a restricted licence refuses orders; the export must not be held back by it.
    vi.spyOn(app.get(LicenceAgentService), 'assert').mockRejectedValue(
      new AppError(403, 'LICENCE_RESTRICTED', 'Restricted'),
    );
    const owner = await signIn(app, kit, 'OWNER');
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const as = () => authHeaders(kit.deviceId, owner.accessToken);
    const started = await request(httpServer(app))
      .post('/api/v1/data-export')
      .set(as())
      .send({ folder });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(DataExportView.parse(started.body).status).toBe('RUNNING');
    await app.get(DataExportService).settled();
    const last = DataExportResponse.parse(
      (await request(httpServer(app)).get('/api/v1/data-export').set(as())).body,
    ).last;
    expect(last, JSON.stringify(last)).toMatchObject({ status: 'DONE', error: null });
    const out = last?.folder ?? '';

    // Every table, in both formats, row for row.
    const orders = await prisma.order.count();
    const jsonLines = readFileSync(join(out, 'json', 'orders.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(jsonLines).toHaveLength(orders);
    const csv = readFileSync(join(out, 'csv', 'orders.csv'), 'utf8')
      .trim()
      .split('\r\n');
    expect(csv).toHaveLength(orders + 1);
    expect(csv[0]).toMatch(/^id,restaurant_id,/);
    expect(existsSync(join(out, 'json', 'items.jsonl'))).toBe(true);

    // No secrets.
    expect(existsSync(join(out, 'json', 'credentials.jsonl'))).toBe(false);
    expect(existsSync(join(out, 'json', 'sessions.jsonl'))).toBe(false);
    expect(existsSync(join(out, 'json', 'system_meta.jsonl'))).toBe(false);
    expect(readFileSync(join(out, 'csv', 'devices.csv'), 'utf8')).not.toContain('secret_hash');

    // The invoice register and the PDF books, by financial year.
    const invoices = await prisma.invoice.count();
    const register = readFileSync(join(out, 'invoice-register.csv'), 'utf8').trim().split('\r\n');
    expect(register).toHaveLength(invoices + 1);
    expect(readdirSync(join(out, 'invoices'))).toEqual(['FY2023-24', 'FY2024-25']);
    expect(readdirSync(join(out, 'invoices', 'FY2024-25', '2024-04'))).toEqual(['2024-04-01.pdf']);
    expect(readFileSync(join(out, 'README.txt'), 'utf8')).toMatch(
      /Amounts in the tables are in paise/,
    );

    expect(
      await prisma.auditLog.count({ where: { action: 'DATA_EXPORTED', actorId: kit.staff.OWNER } }),
    ).toBe(1);
  }, 120_000);

  it('[SEC-004] neutralises formulas in its CSV files and the invoice register, the JSON keeping them as typed', async () => {
    const formula = '=HYPERLINK("http://example.test","Click")';
    const order = await prisma.order.findFirstOrThrow({ orderBy: { id: 'asc' } });
    await prisma.order.update({ where: { id: order.id }, data: { notes: formula } });
    const invoice = await prisma.invoice.findFirstOrThrow({ orderBy: { id: 'asc' } });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { customerName: '+1+2' } });
    const owner = await signIn(app, kit, 'OWNER');
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const started = await request(httpServer(app))
      .post('/api/v1/data-export')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send({ folder: mkdtempSync(join(tmpdir(), 'rp-export-formulas-')) });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await app.get(DataExportService).settled();
    const out = DataExportView.parse(started.body).folder;

    const csv = readFileSync(join(out, 'csv', 'orders.csv'), 'utf8');
    expect(csv).toContain(`"'=HYPERLINK(""http://example.test"",""Click"")"`);
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    const json = readFileSync(join(out, 'json', 'orders.jsonl'), 'utf8');
    expect(json).toContain(JSON.stringify(formula).slice(1, -1));
    const register = readFileSync(join(out, 'invoice-register.csv'), 'utf8');
    expect(register).toContain(`${invoice.invoiceNumber},`);
    expect(register).toContain(",'+1+2,");
    expect(register).not.toMatch(/,\+1\+2,/);
  }, 120_000);

  it('wants the whole path of the folder', async () => {
    const owner = await signIn(app, kit, 'OWNER');
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const refused = await request(httpServer(app))
      .post('/api/v1/data-export')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send({ folder: 'exports' });
    expect([refused.status, ApiError.parse(refused.body).code]).toEqual([422, 'NO_EXPORT_FOLDER']);
  });

  it('is the Owner’s', async () => {
    const manager = await signIn(app, kit, 'MANAGER');
    const refused = await request(httpServer(app))
      .post('/api/v1/data-export')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ folder });
    expect(refused.status).toBe(403);
  });
});
