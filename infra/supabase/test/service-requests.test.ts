import { randomUUID } from 'node:crypto';
import type { ApiError } from '@rp/contracts/relay';
import {
  BROWSER_ID_HEADER,
  QrServiceRequestPickupResponse,
  QrServiceRequestResponse,
  QrServiceRequestView,
  TABLE_TOKEN_HEADER,
  UpdateQrServiceRequestResponse,
} from '@rp/contracts/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FunctionContext, Handler } from '../src/http.js';
import { server } from '../src/server.js';
import { serviceRequest } from '../src/service-request.js';
import { qrMenuDocument } from './helpers/qr-menu.js';
import {
  edgeDatabase,
  lastSeen,
  openRelayDb,
  publishMenu,
  type RelayDb,
  seedTenant,
  type SeededTenant,
} from './helpers/relay-db.js';

/**
 * Call waiter / request bill from the QR page (P5-05c, QR-011): the diner's side and the local
 * server's, one open request of each kind per table, never across tables or restaurants.
 */

let db: RelayDb;
let context: FunctionContext;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = await openRelayDb();
  context = { db: edgeDatabase(db), now: () => new Date(), allowedOrigins: [] };
  a = await seedTenant(db, 'Request House');
  b = await seedTenant(db, 'Other House');
  await publishMenu(db, a.id, 2, qrMenuDocument());
  await publishMenu(db, b.id, 2, qrMenuDocument());
});

afterAll(async () => {
  await db.close();
});

async function call(
  handler: Handler,
  path: string,
  init: { method: string; body?: unknown; headers: Record<string, string> },
) {
  const response = await handler(
    new Request(`https://relay.example.invalid/functions/v1/${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json', ...init.headers },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    }),
    context,
  );
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

const ask = (
  type: string,
  token = a.tables[1].token,
  browser = 'browser-requests-001',
  key = randomUUID(),
) =>
  call(serviceRequest, 'service-request', {
    method: 'POST',
    body: { type, idempotencyKey: key },
    headers: { [TABLE_TOKEN_HEADER]: token, [BROWSER_ID_HEADER]: browser },
  });

const follow = (id: string, token = a.tables[1].token) =>
  call(serviceRequest, `service-request?id=${id}`, {
    method: 'GET',
    headers: { [TABLE_TOKEN_HEADER]: token },
  });

const asServer = (path: string, method: string, body?: unknown, credential = a.credential) =>
  call(server, `server/${path}`, {
    method,
    body,
    headers: { authorization: `Bearer ${credential}` },
  });

const codeOf = (body: unknown) => (body as ApiError).code;

describe('[QR-011] a diner calls a waiter or asks for the bill', () => {
  it('raises one open request of each kind per table, whoever presses', async () => {
    const first = QrServiceRequestResponse.parse((await ask('WAITER')).body);
    expect(first).toMatchObject({
      existing: false,
      request: { type: 'WAITER', status: 'SUBMITTED' },
    });
    const again = QrServiceRequestResponse.parse(
      (await ask('WAITER', a.tables[1].token, 'browser-requests-002')).body,
    );
    expect(again).toEqual({ existing: true, request: first.request });
    const bill = QrServiceRequestResponse.parse((await ask('BILL')).body);
    expect(bill.existing).toBe(false);
    expect(bill.request.id).not.toBe(first.request.id);
  });

  it('[ORD-013] finds the same request when it is sent again', async () => {
    const key = randomUUID();
    const sent = QrServiceRequestResponse.parse(
      (await ask('WATER', a.tables[1].token, 'browser-requests-001', key)).body,
    );
    const resent = QrServiceRequestResponse.parse(
      (await ask('WATER', a.tables[1].token, 'browser-requests-001', key)).body,
    );
    expect(resent).toEqual({ existing: true, request: sent.request });
  });

  it('follows the request, and only at its own table', async () => {
    const { request } = QrServiceRequestResponse.parse((await ask('WAITER')).body);
    expect(QrServiceRequestView.parse((await follow(request.id)).body).id).toBe(request.id);
    expect((await follow(request.id, a.tables[0].token)).status).toBe(404);
    expect((await follow(request.id, b.tables[0].token)).status).toBe(404);
  });

  it('is off when the restaurant takes requests in person only', async () => {
    const tenant = await seedTenant(db, 'In Person');
    await publishMenu(db, tenant.id, 2, qrMenuDocument({ serviceRequests: false }));
    const response = await ask('WAITER', tenant.tables[0].token);
    expect(response.status).toBe(409);
    expect(codeOf(response.body)).toBe('SERVICE_REQUESTS_OFF');
  });

  it('[QR-008] says to call a waiter while the restaurant is offline', async () => {
    const tenant = await seedTenant(db, 'Gone Quiet');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    await lastSeen(db, tenant.id, 600);
    const response = await ask('BILL', tenant.tables[0].token);
    expect(response.status).toBe(503);
    expect(codeOf(response.body)).toBe('RESTAURANT_OFFLINE');
  });

  it('[QR-006] limits one browser’s requests', async () => {
    const tenant = await seedTenant(db, 'Busy Buttons');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const browser = 'browser-presses-a-lot';
    let last = 200;
    for (let index = 0; index < 7; index += 1) {
      const response = await ask(
        index % 2 === 0 ? 'WATER' : 'WAITER',
        tenant.tables[1].token,
        browser,
      );
      last = response.status;
      // Each answered request is closed at once, so the next one is new.
      const body = QrServiceRequestResponse.safeParse(response.body);
      if (body.success) {
        await db.admin.query(
          "UPDATE relay.qr_service_requests SET status = 'REJECTED' WHERE id = $1",
          [body.data.request.id],
        );
      }
    }
    expect(last).toBe(429);
  });
});

/** Staff close a request (DONE through RECEIVED) or the restaurant rejects it, by the superuser. */
async function close(id: string, status: 'DONE' | 'REJECTED'): Promise<void> {
  for (const step of status === 'DONE' ? ['RECEIVED', 'DONE'] : ['REJECTED']) {
    await db.admin.query('UPDATE relay.qr_service_requests SET status = $2 WHERE id = $1', [
      id,
      step,
    ]);
  }
}

/** Raises a request and returns its id, failing the test when it is not taken. */
async function raised(...args: Parameters<typeof ask>): Promise<string> {
  const response = await ask(...args);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return QrServiceRequestResponse.parse(response.body).request.id;
}

describe('[RELAY-D2] [QR-011] limits per table and per browser', () => {
  it('limits a table to 10 requests in 10 minutes, whoever sends them, rejected ones not counted', async () => {
    const tenant = await seedTenant(db, 'Pestered Table');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const table = tenant.tables[1].token;
    // One the restaurant rejected does not count against the table: ten more fit after it.
    await close(await raised('WAITER', table, 'browser-pester-rejected'), 'REJECTED');
    for (let index = 0; index < 10; index += 1) {
      const browser = `browser-pester-${String(index).padStart(4, '0')}`;
      await close(await raised('WAITER', table, browser), 'DONE');
    }
    const limited = await ask('WAITER', table, 'browser-pester-new-one');
    expect(limited.status).toBe(429);
    expect(codeOf(limited.body)).toBe('RATE_LIMITED');
    const wait = (limited.body as ApiError).details?.retryAfterSeconds;
    expect(wait).toBeGreaterThan(590);
    expect(wait).toBeLessThanOrEqual(600);
    // The table next to it is not affected.
    await raised('WAITER', tenant.tables[0].token, 'browser-next-table');
  });

  it('limits one browser to 6 requests in 10 minutes across the restaurant’s tables', async () => {
    const tenant = await seedTenant(db, 'Wandering Asker');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const browser = 'browser-wandering-asker';
    for (let index = 0; index < 6; index += 1) {
      const table = index % 2 === 0 ? tenant.tables[0] : tenant.tables[1];
      await close(await raised('WATER', table.token, browser), 'REJECTED');
    }
    const limited = await ask('WATER', tenant.tables[0].token, browser);
    expect(limited.status).toBe(429);
    expect(Number((limited.body as ApiError).details?.retryAfterSeconds)).toBeGreaterThan(0);
  });

  it('lets no burst of presses slip past the limit', async () => {
    const tenant = await seedTenant(db, 'Burst Buttons');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const browser = 'browser-burst-buttons';
    for (let index = 0; index < 4; index += 1) {
      await close(await raised('WATER', tenant.tables[1].token, browser), 'DONE');
    }
    // Three kinds at once from the same browser: two fit under its six, the third waits.
    const responses = await Promise.all(
      (['WATER', 'WAITER', 'BILL'] as const).map((type) =>
        ask(type, tenant.tables[1].token, browser),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429]);
  });

  it('still finds the open request when a press comes over the limit', async () => {
    const tenant = await seedTenant(db, 'Open Over Limit');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const browser = 'browser-open-over-limit';
    for (let index = 0; index < 5; index += 1) {
      await close(await raised('WATER', tenant.tables[1].token, browser), 'DONE');
    }
    const open = await raised('BILL', tenant.tables[1].token, browser);
    const again = QrServiceRequestResponse.parse(
      (await ask('BILL', tenant.tables[1].token, browser)).body,
    );
    expect(again).toMatchObject({ existing: true, request: { id: open } });
  });
});

describe('[QR-011] the restaurant picks requests up and says how they went', () => {
  it('lists its own waiting requests and moves them on, as the diner sees', async () => {
    const tenant = await seedTenant(db, 'Pickup Requests');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const { request } = QrServiceRequestResponse.parse(
      (await ask('BILL', tenant.tables[1].token)).body,
    );
    const listed = QrServiceRequestPickupResponse.parse(
      (await asServer('service-requests', 'GET', undefined, tenant.credential)).body,
    );
    expect(listed.requests.map((entry) => entry.id)).toContain(request.id);
    expect(listed.requests.find((entry) => entry.id === request.id)).toMatchObject({
      tableId: tenant.tables[1].id,
      type: 'BILL',
    });
    for (const status of ['RECEIVED', 'ACKNOWLEDGED', 'DONE'] as const) {
      const moved = await asServer(
        `service-requests/${request.id}/status`,
        'POST',
        { status },
        tenant.credential,
      );
      expect(UpdateQrServiceRequestResponse.parse(moved.body)).toEqual({ id: request.id, status });
      expect(
        QrServiceRequestView.parse((await follow(request.id, tenant.tables[1].token)).body).status,
      ).toBe(status);
    }
    const back = await asServer(
      `service-requests/${request.id}/status`,
      'POST',
      { status: 'RECEIVED' },
      tenant.credential,
    );
    expect(back.status).toBe(409);
    // Done, so a new one may be asked for.
    expect(
      QrServiceRequestResponse.parse((await ask('BILL', tenant.tables[1].token)).body).existing,
    ).toBe(false);
  });

  it('marks one received too late as expired', async () => {
    const tenant = await seedTenant(db, 'Late Requests');
    await publishMenu(db, tenant.id, 2, qrMenuDocument());
    const { request } = QrServiceRequestResponse.parse(
      (await ask('WAITER', tenant.tables[1].token)).body,
    );
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        "UPDATE relay.qr_service_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
        [request.id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(
      QrServiceRequestView.parse((await follow(request.id, tenant.tables[1].token)).body).status,
    ).toBe('EXPIRED');
    const late = await asServer(
      `service-requests/${request.id}/status`,
      'POST',
      { status: 'RECEIVED' },
      tenant.credential,
    );
    expect(late.status).toBe(410);
    const { rows } = await db.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_service_requests WHERE id = $1',
      [request.id],
    );
    expect(rows[0]?.status).toBe('EXPIRED');
  });

  it('[QR-014] never touches another restaurant’s request', async () => {
    const { request } = QrServiceRequestResponse.parse(
      (await ask('WAITER', b.tables[1].token)).body,
    );
    const response = await asServer(`service-requests/${request.id}/status`, 'POST', {
      status: 'RECEIVED',
    });
    expect(response.status).toBe(404);
  });
});
