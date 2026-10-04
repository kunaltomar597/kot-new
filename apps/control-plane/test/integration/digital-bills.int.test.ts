import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ApiError, DigitalBillView } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  BILL_SENDERS,
  type BillMessage,
  BillSendError,
  type BillSender,
} from '../../src/digital-bills/bill-sender.js';
import { DigitalBillsService } from '../../src/digital-bills/digital-bills.service.js';
import { enrolledInstallation, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';

/**
 * Digital bills at the Control Plane (P7-09a, BILL-012, SEC-002): a restaurant's PC asks, the
 * vendor's provider sends (here a scripted stand-in: CI never messages anyone), the diner opens
 * the bill behind the link until it expires, and only the number's last four digits are stored.
 */

const PUBLIC_URL = 'https://cloud.example.in';
/** The provider's next answers, in order; `sent` records what it was asked to send. */
const script: (() => Promise<{ providerMessageId: string }>)[] = [];
const sent: BillMessage[] = [];
const whatsapp: BillSender = {
  channel: 'WHATSAPP',
  send: (message) => {
    sent.push(message);
    const next = script.shift() ?? (() => Promise.resolve({ providerMessageId: 'wamid.ok' }));
    return next();
  },
};

let database: TestDatabase;
let app: INestApplication;
let offApp: INestApplication;
let prisma: PrismaService;
let restaurant: TestInstallation;

function bill(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    channel: 'WHATSAPP',
    phone: '+919876543210',
    restaurantName: 'Spice Route',
    invoiceNumber: 'INV/26-27/0412',
    invoiceDate: '2026-10-04',
    grandTotal: 125_000,
    lines: [
      'SPICE ROUTE',
      'Invoice INV/26-27/0412',
      'Paneer <Tikka>   280.00',
      'TOTAL Rs 1,250.00',
    ],
    keepDays: 30,
    ...overrides,
  };
}

async function send(body: unknown, on: INestApplication = app) {
  return signedPost(on, restaurant, '/v1/digital-bills', JSON.stringify(body));
}

/** The link's path, as the diner opens it. */
const pathOf = (link: string | null) => (link ?? '').replace(PUBLIC_URL, '');

beforeAll(async () => {
  database = await createTestDatabase();
  const config = {
    publicUrl: PUBLIC_URL,
    digitalBillKey: Buffer.alloc(32, 7).toString('base64'),
    digitalBillDailyLimit: 6,
  };
  app = await createTestApp(database.url, config, [
    { provide: BILL_SENDERS, useValue: { WHATSAPP: whatsapp } },
  ]);
  // The same database, as a Control Plane without a provider.
  offApp = await createTestApp(database.url);
  prisma = app.get(PrismaService);
  restaurant = await enrolledInstallation(app);
});

afterAll(async () => {
  await offApp.close();
  await app.close();
  await database.drop();
});

describe('[BILL-012] [SEC-002] digital bills', () => {
  it('sends the bill once with a link to it, and keeps only the last four digits', async () => {
    const body = bill();
    const first = await send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const view = DigitalBillView.parse(first.body);
    expect(view).toMatchObject({
      id: body.id,
      channel: 'WHATSAPP',
      phone: '+91 ******3210',
      status: 'SENT',
      error: null,
      retryable: false,
    });
    expect(view.link).toMatch(/^https:\/\/cloud\.example\.in\/v1\/bills\/[A-Za-z0-9_-]{43}$/);
    expect(sent.at(-1)).toMatchObject({
      phone: '+919876543210',
      restaurantName: 'Spice Route',
      invoiceNumber: 'INV/26-27/0412',
      amount: '₹1,250.00',
      link: view.link,
    });
    expect(Date.parse(view.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    // The same send again: the first answer, and no second message.
    const again = DigitalBillView.parse((await send(body)).body);
    expect(again).toEqual(view);
    expect(sent.filter((message) => message.link === view.link)).toHaveLength(1);

    // The full number and the link's token are nowhere in what is stored.
    const row = await prisma.digitalBill.findFirstOrThrow({ where: { requestId: body.id } });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('9876543210');
    expect(stored).not.toContain(pathOf(view.link).split('/').pop());

    // The diner opens it: the bill as printed, escaped, on a page that runs nothing.
    const page = await request(httpServer(app)).get(pathOf(view.link));
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.text).toContain('Paneer &lt;Tikka&gt;');
    expect(page.text).toContain('TOTAL Rs 1,250.00');
  });

  it('says why a bill was not sent, and sends it when asked again', async () => {
    script.push(() =>
      Promise.reject(new BillSendError('PROVIDER_FAILED', 'WhatsApp could not be reached.', true)),
    );
    const body = bill();
    const failed = DigitalBillView.parse((await send(body)).body);
    expect(failed).toMatchObject({
      status: 'FAILED',
      error: 'WhatsApp could not be reached.',
      retryable: true,
    });
    const retried = DigitalBillView.parse((await send(body)).body);
    expect(retried).toMatchObject({ status: 'SENT', error: null, link: failed.link });
    expect(
      await prisma.digitalBill.findFirstOrThrow({ where: { requestId: body.id } }),
    ).toMatchObject({ attempts: 2, providerMessageId: 'wamid.ok' });

    script.push(() =>
      Promise.reject(new BillSendError('NUMBER_REJECTED', 'Not on WhatsApp.', false)),
    );
    const rejected = DigitalBillView.parse((await send(bill())).body);
    expect(rejected).toMatchObject({ status: 'FAILED', retryable: false });
  });

  it('deletes the bill when its link expires', async () => {
    const view = DigitalBillView.parse((await send(bill({ keepDays: 1 }))).body);
    const bills = app.get(DigitalBillsService);
    expect(await bills.purge(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThanOrEqual(1);
    const page = await request(httpServer(app)).get(pathOf(view.link));
    expect(page.status).toBe(410);
    expect(page.text).toContain('no longer available');
    const row = await prisma.digitalBill.findFirstOrThrow({ where: { requestId: view.id } });
    expect([row.lines, row.purgedAt === null]).toEqual([null, false]);
  });

  it('refuses channels the vendor has not set up, and more bills than the day allows', async () => {
    const sms = await send(bill({ channel: 'SMS' }));
    expect([sms.status, ApiError.parse(sms.body).code]).toEqual([503, 'DIGITAL_BILLS_NOT_SET_UP']);
    const off = await send(bill(), offApp);
    expect([off.status, ApiError.parse(off.body).code]).toEqual([503, 'DIGITAL_BILLS_NOT_SET_UP']);

    // Six a day here; four were sent above.
    expect((await send(bill())).status).toBe(200);
    expect((await send(bill())).status).toBe(200);
    const over = await send(bill());
    expect([over.status, ApiError.parse(over.body).code]).toEqual([429, 'DIGITAL_BILL_LIMIT']);
  });

  it('opens nothing without a signature or with a wrong link', async () => {
    const unsigned = await request(httpServer(app))
      .post('/v1/digital-bills')
      .set('content-type', 'application/json')
      .send(JSON.stringify(bill()));
    expect(unsigned.status).toBe(401);
    const unknown = await request(httpServer(app)).get(`/v1/bills/${'a'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-type']).toMatch(/^text\/html/);
    expect((await request(httpServer(app)).get('/v1/bills/short')).status).toBe(404);
  });
});
