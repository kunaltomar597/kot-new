import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BILL_PAGE_HEADERS, billPage, escapeHtml } from '../../src/digital-bills/bill-page.js';
import {
  type BillMessage,
  BillSendError,
  billSendersFor,
  WhatsAppCloudSender,
} from '../../src/digital-bills/bill-sender.js';
import { CpConfigSchema } from '../../src/config/cp-config.js';

/** Digital bills at the Control Plane (P7-09a, BILL-012): the WhatsApp adapter and the page. */

const MESSAGE: BillMessage = {
  phone: '+919876543210',
  restaurantName: 'Spice Route',
  invoiceNumber: 'INV/26-27/0412',
  amount: '₹1,250.00',
  link: 'https://cloud.example.in/v1/bills/abc',
  expiresOn: '03-11-2026',
};

function sender(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const whatsapp = new WhatsAppCloudSender({
    token: 'test-token',
    phoneNumberId: '1234567890',
    template: 'digital_bill',
    language: 'en',
    apiUrl: 'https://graph.example/v21.0',
    timeoutMs: 1_000,
    fetch: (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
      return Promise.resolve(answer());
    },
  });
  return { whatsapp, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function failure(promise: Promise<unknown>): Promise<BillSendError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof BillSendError))
    throw new Error(`Expected a BillSendError: ${String(error)}`);
  return error;
}

describe('[BILL-012] the WhatsApp adapter', () => {
  it('sends the approved template with the bill’s details, and returns the message id', async () => {
    const { whatsapp, calls } = sender(() => json(200, { messages: [{ id: 'wamid.1' }] }));
    await expect(whatsapp.send(MESSAGE)).resolves.toEqual({ providerMessageId: 'wamid.1' });
    expect(calls[0]?.url).toBe('https://graph.example/v21.0/1234567890/messages');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer test-token');
    const body = calls[0]?.init.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'digital_bill',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Spice Route' },
              { type: 'text', text: 'INV/26-27/0412' },
              { type: 'text', text: '₹1,250.00' },
              { type: 'text', text: 'https://cloud.example.in/v1/bills/abc' },
              { type: 'text', text: '03-11-2026' },
            ],
          },
        ],
      },
    });
  });

  it('says when a number cannot get WhatsApp, which trying again will not change', async () => {
    const { whatsapp } = sender(() =>
      json(400, { error: { code: 131026, message: 'Message undeliverable' } }),
    );
    const error = await failure(whatsapp.send(MESSAGE));
    expect([error.code, error.retryable]).toEqual(['NUMBER_REJECTED', false]);
    expect(error.message).toContain('131026');
  });

  it('tries again later when WhatsApp is busy, down or unreachable', async () => {
    for (const answer of [
      () => json(429, { error: { code: 130429, message: 'Rate limit hit' } }),
      () => json(503, {}),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const error = await failure(sender(answer).whatsapp.send(MESSAGE));
      expect([error.code, error.retryable]).toEqual(['PROVIDER_FAILED', true]);
    }
  });

  it('does not try again when the vendor’s set-up is wrong', async () => {
    const { whatsapp } = sender(() =>
      json(401, { error: { code: 190, message: 'Invalid OAuth access token' } }),
    );
    const error = await failure(whatsapp.send(MESSAGE));
    expect([error.code, error.retryable]).toEqual(['PROVIDER_FAILED', false]);
    // The token never appears in what is logged or answered.
    expect(error.message).not.toContain('test-token');
  });
});

describe('[BILL-012] [SEC-002] setting digital bills up', () => {
  const base = { databaseUrl: 'postgresql://localhost/cp' };
  const key = Buffer.alloc(32, 1).toString('base64');

  it('has no channel until the vendor sets one up', () => {
    expect(billSendersFor(CpConfigSchema.parse(base))).toEqual({});
    const config = CpConfigSchema.parse({
      ...base,
      whatsappToken: 'token',
      whatsappPhoneNumberId: '1234567890',
      publicUrl: 'https://cloud.example.in',
      digitalBillKey: key,
    });
    expect(Object.keys(billSendersFor(config))).toEqual(['WHATSAPP']);
  });

  it('refuses a WhatsApp set-up without its number, its links’ address or their key', () => {
    expect(CpConfigSchema.safeParse({ ...base, whatsappToken: 'token' }).success).toBe(false);
    expect(
      CpConfigSchema.safeParse({
        ...base,
        whatsappToken: 'token',
        whatsappPhoneNumberId: '1234567890',
        publicUrl: 'https://cloud.example.in',
      }).success,
    ).toBe(false);
  });
});

describe('[BILL-012] the bill page', () => {
  it('shows the bill as printed, with nothing in it able to run', () => {
    const html = billPage({
      restaurantName: 'Spice <Route>',
      invoiceNumber: 'INV/1',
      lines: ['Paneer Tikka        280.00', '<script>alert(1)</script>'],
      expiresOn: '03-11-2026',
    });
    expect(html).toContain('Spice &lt;Route&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('available until 03-11-2026');
    expect(escapeHtml(`a&b"c'`)).toBe('a&amp;b&quot;c&#39;');
  });

  it('[SEC-017] allows the page’s own styles by their hash, and no other inline style', () => {
    const policy = BILL_PAGE_HEADERS['content-security-policy'] ?? '';
    expect(policy).not.toContain('unsafe-inline');
    const html = billPage({
      restaurantName: 'Spice Route',
      invoiceNumber: 'INV/1',
      lines: ['Paneer Tikka        280.00'],
      expiresOn: '03-11-2026',
    });
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '');
    expect(styles).toHaveLength(1);
    const hash = createHash('sha256')
      .update(styles[0] ?? '', 'utf8')
      .digest('base64');
    expect(policy).toContain(`style-src 'sha256-${hash}';`);
    expect(html).not.toContain('style=');
  });
});
