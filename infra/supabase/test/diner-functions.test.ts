import { randomUUID } from 'node:crypto';
import type { ApiError, OrderLineRequest } from '@rp/contracts/relay';
import {
  BROWSER_ID_HEADER,
  QrMenuResponse,
  QrOrderView,
  QrSubmitOrderResponse,
  TABLE_TOKEN_HEADER,
} from '@rp/contracts/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FunctionContext, Handler } from '../src/http.js';
import { orderStatus } from '../src/order-status.js';
import { qrMenu } from '../src/qr-menu.js';
import { submitOrder } from '../src/submit-order.js';
import { IDS, POS_ONLY, qrMenuDocument } from './helpers/qr-menu.js';
import {
  edgeDatabase,
  letExpire,
  lastSeen,
  newTableToken,
  openRelayDb,
  publishMenu,
  type RelayDb,
  seedTenant,
  type SeededTenant,
  sha256,
} from './helpers/relay-db.js';

/**
 * The diner-facing relay functions (P5-02a): the menu, submitting an order and its status, called
 * as a browser would, with the functions running on the edge functions' own login.
 */

const SITE = 'https://menu.example.in';
let db: RelayDb;
let context: FunctionContext;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  context = { db: edgeDatabase(db), now: () => new Date(), allowedOrigins: [SITE] };
  a = await seedTenant(db, 'Spice Route');
  b = await seedTenant(db, 'Coastal Kitchen');
  await publishMenu(db, a.id, 2, qrMenuDocument());
  await publishMenu(db, b.id, 2, qrMenuDocument({ restaurantName: 'Coastal Kitchen' }));
  // Many orders go to A's first table here; the limit itself is tested on its own restaurants.
  await setLimit(a.id, 50);
  await setLimit(b.id, 50);
});

afterAll(async () => {
  await db.close();
});

interface Call {
  token?: string | null;
  browser?: string | null;
  body?: unknown;
  query?: string;
  method?: string;
  origin?: string;
}

async function call(handler: Handler, path: string, options: Call = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.token !== null) headers.set(TABLE_TOKEN_HEADER, options.token ?? a.tables[0].token);
  if (options.browser !== null)
    headers.set(BROWSER_ID_HEADER, options.browser ?? 'browser-aaaaaaaaaaaa');
  if (options.origin !== undefined) headers.set('origin', options.origin);
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const response = await handler(
    new Request(`https://relay.example.invalid/functions/v1/${path}${options.query ?? ''}`, {
      method,
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    }),
    context,
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
}

const codeOf = (body: unknown) => (body as ApiError).code;

const dal = (overrides: Partial<OrderLineRequest> = {}): OrderLineRequest => ({
  clientLineId: randomUUID(),
  itemId: IDS.dal,
  quantity: 2,
  modifiers: [],
  ...overrides,
});

const order = (lines: OrderLineRequest[] = [dal()], extra: object = {}) => ({
  idempotencyKey: randomUUID(),
  lines,
  ...extra,
});

const submit = (body: unknown, options: Call = {}) =>
  call(submitOrder, 'submit-order', { ...options, body });

async function accepted(body: unknown, options: Call = {}) {
  const response = await submit(body, options);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const answer = QrSubmitOrderResponse.parse(response.body);
  if (answer.status !== 'ACCEPTED') throw new Error(JSON.stringify(answer));
  return answer;
}

const ordersOf = async (tenantId: string) =>
  (
    await db.admin.query<{
      id: string;
      table_id: string;
      browser_id: string;
      snapshot_version: string;
    }>(
      'SELECT id, table_id, browser_id, snapshot_version FROM relay.qr_orders WHERE tenant_id = $1',
      [tenantId],
    )
  ).rows;

const setLimit = (tenantId: string, perWindow: number) =>
  db.as('relay_writer', { tenant_id: tenantId }, (client) =>
    client.query(
      'UPDATE relay.tenant_settings SET submissions_per_window = $2 WHERE tenant_id = $1',
      [tenantId, perWindow],
    ),
  );

describe('[QR-002] [QR-008] the menu', () => {
  it('gives the table its latest menu, label and pickup time', async () => {
    const response = await call(qrMenu, 'qr-menu');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const menu = QrMenuResponse.parse(response.body);
    expect(menu).toMatchObject({
      table: { label: 'T1' },
      version: 2,
      readOnly: false,
      pickupTimeoutSeconds: 60,
    });
    expect(menu.document?.restaurantName).toBe('Spice Route');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('turns read-only when the restaurant has not been heard from for its read-only time', async () => {
    await lastSeen(db, a.id, 121);
    expect(QrMenuResponse.parse((await call(qrMenu, 'qr-menu')).body).readOnly).toBe(true);
    await lastSeen(db, a.id, 119);
    expect(QrMenuResponse.parse((await call(qrMenu, 'qr-menu')).body).readOnly).toBe(false);
  });

  it('[QR-001] opens nothing without a valid token', async () => {
    expect((await call(qrMenu, 'qr-menu', { token: null })).status).toBe(400);
    expect((await call(qrMenu, 'qr-menu', { token: 'short' })).status).toBe(400);
    const unknown = await call(qrMenu, 'qr-menu', { token: newTableToken() });
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown.body)).toBe('TABLE_NOT_FOUND');
  });

  it('says so while the restaurant has no menu yet', async () => {
    const fresh = await seedTenant(db, 'Not Yet Open');
    // The seed's first snapshot is not a QR menu document; a new tenant has none at all.
    await db.admin.query('DELETE FROM relay.menu_snapshots WHERE tenant_id = $1', [fresh.id]);
    const response = await call(qrMenu, 'qr-menu', { token: fresh.tables[0].token });
    expect(response.status).toBe(503);
    expect(codeOf(response.body)).toBe('MENU_NOT_PUBLISHED');
  });
});

describe('[QR-006] submitting an order', () => {
  it('stores a valid order as SUBMITTED, expiring after the pickup time', async () => {
    const answer = await accepted(
      order([dal({ instructions: 'Less butter' })], { customerName: 'Asha' }),
    );
    expect(answer.replayed).toBe(false);
    expect(answer.order).toMatchObject({
      status: 'SUBMITTED',
      customerName: 'Asha',
      orderNote: null,
    });
    expect(Date.parse(answer.order.expiresAt) - Date.parse(answer.order.submittedAt)).toBe(60_000);
    const stored = (await ordersOf(a.id)).find((row) => row.id === answer.order.id);
    expect(stored).toMatchObject({
      table_id: a.tables[0].id,
      browser_id: 'browser-aaaaaaaaaaaa',
      snapshot_version: '2',
    });
  });

  it('[ORD-013] returns the original order when the same submission comes again', async () => {
    const body = order();
    const first = await accepted(body);
    const again = await accepted(body);
    expect(again.replayed).toBe(true);
    expect(again.order.id).toBe(first.order.id);
    expect((await ordersOf(a.id)).filter((row) => row.id === first.order.id)).toHaveLength(1);
  });

  it('[ORD-013] stores a burst of the same submission once', async () => {
    const body = order();
    const answers = await Promise.all(Array.from({ length: 5 }, () => accepted(body)));
    expect(new Set(answers.map((answer) => answer.order.id)).size).toBe(1);
    expect(answers.filter((answer) => !answer.replayed)).toHaveLength(1);
  });

  it('refuses a key already used at another table', async () => {
    const body = order();
    await accepted(body, { token: a.tables[1].token });
    const response = await submit(body);
    expect(response.status).toBe(409);
    expect(codeOf(response.body)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('[ORD-014] refuses prices or anything else the contract does not have', async () => {
    const priced = await submit(order([{ ...dal(), unitPrice: 1 } as OrderLineRequest]));
    expect(priced.status).toBe(400);
    expect(codeOf(priced.body)).toBe('VALIDATION_FAILED');
    expect((await submit({ ...order(), tableId: a.tables[1].id })).status).toBe(400);
    expect((await submit(order([]))).status).toBe(400);
  });

  it('needs the browser’s id and a JSON body', async () => {
    expect((await submit(order(), { browser: null })).status).toBe(400);
    const notJson = await submitOrder(
      new Request('https://relay.example.invalid/functions/v1/submit-order', {
        method: 'POST',
        headers: {
          [TABLE_TOKEN_HEADER]: a.tables[0].token,
          [BROWSER_ID_HEADER]: 'browser-aaaaaaaaaaaa',
        },
        body: '{not json',
      }),
      context,
    );
    expect(notJson.status).toBe(400);
  });

  it('[ORD-017] reports every line the latest menu cannot serve, and stores nothing', async () => {
    const before = (await ordersOf(a.id)).length;
    const response = await submit(
      order([
        dal(),
        dal({ itemId: POS_ONLY }),
        dal({ itemId: IDS.jamun }),
        dal({ itemId: IDS.tikka }),
        dal({ instructions: 'x'.repeat(141) }),
      ]),
    );
    expect(response.status).toBe(200);
    const answer = QrSubmitOrderResponse.parse(response.body);
    if (answer.status !== 'REJECTED') throw new Error('expected a rejection');
    expect(answer.version).toBe(2);
    expect(answer.rejectedLines.map((line) => line.code)).toEqual([
      'NOT_ON_CHANNEL',
      'OUT_OF_STOCK',
      'INVALID_SELECTION',
      'INVALID_SELECTION',
    ]);
    expect(await ordersOf(a.id)).toHaveLength(before);
  });

  it('[MENU-012] checks combos and choices as the restaurant does', async () => {
    const thali = (choices: string[]) =>
      dal({ itemId: IDS.thali, quantity: 1, comboChoices: choices });
    const answer = await submit(order([thali([IDS.rasmalai])]));
    expect(QrSubmitOrderResponse.parse(answer.body).status).toBe('ACCEPTED');
    const wrong = QrSubmitOrderResponse.parse((await submit(order([thali([IDS.tikka])]))).body);
    expect(wrong.status).toBe('REJECTED');
  });

  it('checks against the latest menu', async () => {
    const tenant = await seedTenant(db, 'Menu Changer');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const withoutDal = qrMenuDocument();
    withoutDal.menu = {
      ...withoutDal.menu,
      items: withoutDal.menu.items.filter((item) => item.id !== IDS.dal),
    };
    await publishMenu(db, tenant.id, 3, withoutDal);
    const answer = QrSubmitOrderResponse.parse(
      (await submit(order(), { token: tenant.tables[0].token })).body,
    );
    expect(answer).toMatchObject({ status: 'REJECTED', version: 3 });
  });

  it('[QR-008] closes ordering while the restaurant is offline', async () => {
    await lastSeen(db, a.id, 600);
    const response = await submit(order());
    expect(response.status).toBe(503);
    expect(codeOf(response.body)).toBe('RESTAURANT_OFFLINE');
    await lastSeen(db, a.id, 0);
  });
});

describe('[QR-006] rate limits', () => {
  it('limits orders per table in the window, saying when to try again', async () => {
    const tenant = await seedTenant(db, 'Busy Table');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    await setLimit(tenant.id, 3);
    const options = (n: number) => ({
      token: tenant.tables[0].token,
      browser: `browser-table-${String(n).padStart(6, '0')}`,
    });
    // The seed already placed one order at this table.
    await accepted(order(), options(1));
    await accepted(order(), options(2));
    const limited = await submit(order(), options(3));
    expect(limited.status).toBe(429);
    expect(codeOf(limited.body)).toBe('RATE_LIMITED');
    const wait = Number(limited.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(590);
    expect(wait).toBeLessThanOrEqual(600);
    expect((limited.body as ApiError).details).toEqual({ retryAfterSeconds: wait });
    // Another table of the same restaurant is not affected.
    await accepted(order(), { token: tenant.tables[1].token, browser: 'browser-other-table' });
  });

  it('limits one browser across tables', async () => {
    const tenant = await seedTenant(db, 'Wandering Diner');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    await setLimit(tenant.id, 2);
    const browser = 'browser-wanderer-01';
    await accepted(order(), { token: tenant.tables[0].token, browser });
    await accepted(order(), { token: tenant.tables[1].token, browser });
    const limited = await submit(order(), { token: tenant.tables[1].token, browser });
    expect(limited.status).toBe(429);
  });

  it('lets no burst slip past the limit', async () => {
    const tenant = await seedTenant(db, 'Burst House');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    await setLimit(tenant.id, 3);
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        submit(order(), {
          token: tenant.tables[1].token,
          browser: `browser-burst-${String(n).padStart(6, '0')}`,
        }),
      ),
    );
    // One order from the seed is already at this table.
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
  });

  it('does not count a replay against the limit', async () => {
    const tenant = await seedTenant(db, 'Replay House');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    await setLimit(tenant.id, 2);
    const body = order();
    await accepted(body, { token: tenant.tables[0].token });
    const again = await accepted(body, { token: tenant.tables[0].token });
    expect(again.replayed).toBe(true);
  });
});

describe('[QR-007] an order’s status', () => {
  it('shows the diner their order, with what the restaurant said', async () => {
    const { order: placed } = await accepted(order());
    await db.as('relay_writer', { tenant_id: a.id }, async (client) => {
      await client.query("UPDATE relay.qr_orders SET status = 'RECEIVED' WHERE id = $1", [
        placed.id,
      ]);
      await client.query(
        "UPDATE relay.qr_orders SET status = 'REJECTED', status_detail = $2 WHERE id = $1",
        [placed.id, JSON.stringify({ rejectionReason: 'The kitchen is closing' })],
      );
    });
    const response = await call(orderStatus, 'order-status', { query: `?id=${placed.id}` });
    expect(response.status).toBe(200);
    expect(QrOrderView.parse(response.body)).toMatchObject({
      id: placed.id,
      status: 'REJECTED',
      detail: { rejectionReason: 'The kitchen is closing' },
    });
  });

  it('reads EXPIRED as soon as the pickup time has passed', async () => {
    const { order: placed } = await accepted(order());
    await letExpire(db, placed.id);
    const view = QrOrderView.parse(
      (await call(orderStatus, 'order-status', { query: `?id=${placed.id}` })).body,
    );
    expect(view.status).toBe('EXPIRED');
  });

  it('[QR-014] shows nothing of another table or restaurant', async () => {
    const { order: placed } = await accepted(order());
    for (const token of [a.tables[1].token, b.tables[0].token]) {
      const response = await call(orderStatus, 'order-status', {
        token,
        query: `?id=${placed.id}`,
      });
      expect(response.status).toBe(404);
      expect(codeOf(response.body)).toBe('ORDER_NOT_FOUND');
    }
    expect((await call(orderStatus, 'order-status', { query: '?id=nope' })).status).toBe(400);
  });
});

describe('[QR-014] one restaurant’s code never reaches another', () => {
  it('stores an order only for the token’s own table and restaurant', async () => {
    const { order: placed } = await accepted(order(), { token: b.tables[1].token });
    const stored = (await ordersOf(b.id)).find((row) => row.id === placed.id);
    expect(stored?.table_id).toBe(b.tables[1].id);
    expect((await ordersOf(a.id)).some((row) => row.id === placed.id)).toBe(false);
  });

  it('stops a regenerated code at once', async () => {
    const tenant = await seedTenant(db, 'New Codes');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const fresh = newTableToken();
    await db.as('relay_writer', { tenant_id: tenant.id }, (client) =>
      client.query(
        'UPDATE relay.dining_tables SET token_hash = $3 WHERE tenant_id = $1 AND table_id = $2',
        [tenant.id, tenant.tables[0].id, sha256(fresh)],
      ),
    );
    expect((await submit(order(), { token: tenant.tables[0].token })).status).toBe(404);
    await accepted(order(), { token: fresh });
  });
});

describe('browsers', () => {
  it('answers the QR site’s preflight and marks its responses for it', async () => {
    const preflight = await call(submitOrder, 'submit-order', { method: 'OPTIONS', origin: SITE });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(preflight.headers.get('access-control-allow-headers')).toContain(TABLE_TOKEN_HEADER);
    const menu = await call(qrMenu, 'qr-menu', { origin: SITE });
    expect(menu.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('gives other sites no access', async () => {
    const menu = await call(qrMenu, 'qr-menu', { origin: 'https://evil.example' });
    expect(menu.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts only the method each function takes', async () => {
    const wrong = await call(qrMenu, 'qr-menu', { method: 'POST', body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, OPTIONS');
  });
});

describe('[QR-002] refreshing the menu', () => {
  it('sends the menu again only when it changed', async () => {
    const same = QrMenuResponse.parse((await call(qrMenu, 'qr-menu', { query: '?known=2' })).body);
    expect(same).toMatchObject({ version: 2, document: null });
    const older = QrMenuResponse.parse((await call(qrMenu, 'qr-menu', { query: '?known=1' })).body);
    expect(older.document?.restaurantName).toBe('Spice Route');
    expect((await call(qrMenu, 'qr-menu', { query: '?known=abc' })).status).toBe(400);
  });
});
