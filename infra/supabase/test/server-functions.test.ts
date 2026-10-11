import { createHmac, randomUUID } from 'node:crypto';
import type { ApiError } from '@rp/contracts/relay';
import {
  BROWSER_ID_HEADER,
  PublishQrMenuResponse,
  QrMenuResponse,
  QrOrderView,
  QrPickupResponse,
  type QrRelaySettings,
  QrSubmitOrderResponse,
  RelayPhotoSweepResponse,
  RelayPhotoUploadResponse,
  RelayPresenceResponse,
  RelaySessionResponse,
  SyncRelayTablesResponse,
  TABLE_TOKEN_HEADER,
  UpdateQrOrderResponse,
} from '@rp/contracts/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FunctionContext, Handler, PhotoStorage } from '../src/http.js';
import { orderStatus } from '../src/order-status.js';
import { qrMenu } from '../src/qr-menu.js';
import { SESSION_SECONDS, server } from '../src/server.js';
import { submitOrder } from '../src/submit-order.js';
import { IDS, qrMenuDocument } from './helpers/qr-menu.js';
import {
  edgeDatabase,
  letExpire,
  newCredential,
  newTableToken,
  openRelayDb,
  type RelayDb,
  seedTenant,
  type SeededTenant,
  sha256,
} from './helpers/relay-db.js';

/**
 * The `server` function (P5-02b): what a restaurant's local server does at the relay, each call
 * with its credential, and never beyond its own restaurant (SEC-005, QR-014).
 */

const JWT_SECRET = 'test-only-realtime-secret-0123456789abcdef';
const bucket = new Map<string, Uint8Array>();
const photoStorage: PhotoStorage = {
  publicBase: 'https://cdn.example.invalid/storage/v1/object/public/menu-photos',
  put(path, bytes) {
    bucket.set(path, bytes);
    return Promise.resolve();
  },
  remove(paths) {
    for (const path of paths) bucket.delete(path);
    return Promise.resolve();
  },
};
let db: RelayDb;
let context: FunctionContext;
let a: SeededTenant;
let b: SeededTenant;

const SETTINGS: QrRelaySettings = {
  submissionsPerWindow: 5,
  rateLimitWindowMinutes: 10,
  pickupTimeoutSeconds: 60,
  presenceIntervalSeconds: 30,
  readOnlyAfterSeconds: 120,
};

beforeAll(async () => {
  db = await openRelayDb();
  context = {
    db: edgeDatabase(db),
    now: () => new Date(),
    allowedOrigins: [],
    realtimeJwtSecret: JWT_SECRET,
    realtimeApiKey: 'test-publishable-key',
    photos: photoStorage,
  };
  a = await seedTenant(db, 'Server House');
  b = await seedTenant(db, 'Neighbour House');
});

afterAll(async () => {
  await db.close();
});

interface Call {
  method: string;
  body?: unknown;
  credential?: string | null;
  context?: FunctionContext;
}

async function call(
  handler: Handler,
  path: string,
  options: Call & { headers?: Record<string, string> },
) {
  const headers = new Headers({ 'content-type': 'application/json', ...options.headers });
  if (options.credential !== null) {
    headers.set('authorization', `Bearer ${options.credential ?? a.credential}`);
  }
  const response = await handler(
    new Request(`https://relay.example.invalid/functions/v1/${path}`, {
      method: options.method,
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    }),
    options.context ?? context,
  );
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

const asServer = (path: string, options: Call) => call(server, `server/${path}`, options);
const codeOf = (body: unknown) => (body as ApiError).code;

const publish = (version: number, document = qrMenuDocument(), credential?: string) =>
  asServer('menu', { method: 'PUT', body: { version, document }, credential });

const diner = (handler: Handler, path: string, token: string, body?: unknown, query = '') =>
  call(handler, `${path}${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    body,
    credential: null,
    headers: { [TABLE_TOKEN_HEADER]: token, [BROWSER_ID_HEADER]: 'browser-server-tests' },
  });

const dinerOrder = () => ({
  idempotencyKey: randomUUID(),
  lines: [{ clientLineId: randomUUID(), itemId: IDS.dal, quantity: 1, modifiers: [] }],
});

async function placeOrder(token: string): Promise<string> {
  const response = await diner(submitOrder, 'submit-order', token, dinerOrder());
  const answer = QrSubmitOrderResponse.parse(response.body);
  if (answer.status !== 'ACCEPTED') throw new Error(JSON.stringify(answer));
  return answer.order.id;
}

const setStatus = (orderId: string, body: object, credential?: string) =>
  asServer(`orders/${orderId}/status`, { method: 'POST', body, credential });

describe('[VCP-002] [SEC-005] the local server’s credential', () => {
  it('is needed for every call, and only a live one of an active restaurant works', async () => {
    const presence = { serverVersion: '1.0.0', settings: SETTINGS };
    expect(
      (await asServer('presence', { method: 'POST', body: presence, credential: null })).status,
    ).toBe(401);
    const unknown = await asServer('presence', {
      method: 'POST',
      body: presence,
      credential: newCredential(),
    });
    expect(unknown.status).toBe(401);
    expect(codeOf(unknown.body)).toBe('CREDENTIAL_REJECTED');
    expect(
      (
        await asServer('presence', {
          method: 'POST',
          body: presence,
          credential: a.tables[0].token,
        })
      ).status,
    ).toBe(401);

    const tenant = await seedTenant(db, 'Suspended House');
    const ok = () =>
      asServer('presence', { method: 'POST', body: presence, credential: tenant.credential });
    expect((await ok()).status).toBe(200);
    await db.as('relay_provisioner', undefined, (client) =>
      client.query("SELECT relay.set_tenant_status($1, 'SUSPENDED')", [tenant.id]),
    );
    expect((await ok()).status).toBe(401);
    await db.as('relay_provisioner', undefined, (client) =>
      client.query("SELECT relay.set_tenant_status($1, 'ACTIVE')", [tenant.id]),
    );
    await db.as('relay_provisioner', undefined, (client) =>
      client.query('SELECT relay.revoke_credential($1)', [tenant.credentialId]),
    );
    expect((await ok()).status).toBe(401);
  });

  it('answers unknown routes and wrong methods plainly', async () => {
    expect((await asServer('nothing-here', { method: 'GET' })).status).toBe(404);
    const wrong = await asServer('menu', { method: 'GET' });
    expect(wrong.status).toBe(405);
  });
});

describe('[QR-008] presence and the QR settings', () => {
  it('marks the restaurant present and gives the relay’s clock', async () => {
    const tenant = await seedTenant(db, 'Quiet Server');
    await publish(2, qrMenuDocument(), tenant.credential);
    await db.admin.query("UPDATE relay.presence SET server_version = '0' WHERE tenant_id = $1", [
      tenant.id,
    ]);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        "UPDATE relay.presence SET last_seen_at = now() - interval '10 minutes' WHERE tenant_id = $1",
        [tenant.id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const menu = () => diner(qrMenu, 'qr-menu', tenant.tables[0].token);
    expect(QrMenuResponse.parse((await menu()).body).readOnly).toBe(true);
    const response = await asServer('presence', {
      method: 'POST',
      body: { serverVersion: '1.4.0', settings: SETTINGS },
      credential: tenant.credential,
    });
    expect(response.status).toBe(200);
    const { serverTime } = RelayPresenceResponse.parse(response.body);
    expect(Math.abs(Date.parse(serverTime) - Date.now())).toBeLessThan(5_000);
    expect(QrMenuResponse.parse((await menu()).body).readOnly).toBe(false);
  });

  it('[QR-006] [QR-007] applies the restaurant’s settings to the next order', async () => {
    await publish(2);
    await asServer('presence', {
      method: 'POST',
      body: {
        serverVersion: '1.4.0',
        settings: { ...SETTINGS, pickupTimeoutSeconds: 90, submissionsPerWindow: 40 },
      },
    });
    const id = await placeOrder(a.tables[0].token);
    const view = QrOrderView.parse(
      (await diner(orderStatus, 'order-status', a.tables[0].token, undefined, `?id=${id}`)).body,
    );
    expect(Date.parse(view.expiresAt) - Date.parse(view.submittedAt)).toBe(90_000);
    const bad = await asServer('presence', {
      method: 'POST',
      body: { serverVersion: '1.4.0', settings: { ...SETTINGS, pickupTimeoutSeconds: 5 } },
    });
    expect(bad.status).toBe(400);
  });
});

describe('[QR-003] publishing the menu', () => {
  it('publishes newer versions, takes a retry as a replay, and refuses an older one', async () => {
    const tenant = await seedTenant(db, 'Publisher');
    const as = (version: number, document = qrMenuDocument()) =>
      publish(version, document, tenant.credential);
    expect(PublishQrMenuResponse.parse((await as(5)).body)).toEqual({
      version: 5,
      replayed: false,
    });
    expect(PublishQrMenuResponse.parse((await as(5)).body)).toEqual({ version: 5, replayed: true });
    const changed = await as(5, qrMenuDocument({ restaurantName: 'Renamed' }));
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'STALE_MENU_VERSION', details: { latest: 5 } });
    const older = await as(4);
    expect(older.status).toBe(409);
    expect((await as(6, qrMenuDocument({ restaurantName: 'Renamed' }))).status).toBe(200);
    const menu = QrMenuResponse.parse(
      (await diner(qrMenu, 'qr-menu', tenant.tables[0].token)).body,
    );
    expect(menu).toMatchObject({ version: 6, document: { restaurantName: 'Renamed' } });
  });

  it('refuses a document that does not match the contract', async () => {
    const response = await asServer('menu', {
      method: 'PUT',
      body: { version: 9, document: { ...qrMenuDocument(), extra: true } },
    });
    expect(response.status).toBe(400);
  });

  it('[QR-014] publishes to its own restaurant only', async () => {
    await publish(20, qrMenuDocument({ restaurantName: 'Server House Special' }));
    const theirs = QrMenuResponse.parse((await diner(qrMenu, 'qr-menu', b.tables[0].token)).body);
    expect(theirs.document?.restaurantName).not.toBe('Server House Special');
  });
});

describe('[QR-001] the tables and their QR codes', () => {
  it('opens a table by its new code, stops the old one, and takes out tables left out', async () => {
    const tenant = await seedTenant(db, 'Table Keeper');
    await publish(2, qrMenuDocument(), tenant.credential);
    const [first, second] = tenant.tables;
    const regenerated = newTableToken();
    const extra = { tableId: randomUUID(), label: 'Patio 1', token: newTableToken() };
    const response = await asServer('tables', {
      method: 'PUT',
      credential: tenant.credential,
      body: {
        tables: [
          {
            tableId: first.id,
            label: 'T1',
            tokenHash: sha256(regenerated).toString('hex'),
            active: true,
          },
          {
            tableId: extra.tableId,
            label: extra.label,
            tokenHash: sha256(extra.token).toString('hex'),
            active: true,
          },
        ],
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(SyncRelayTablesResponse.parse(response.body)).toEqual({ withCode: 2, deactivated: 1 });
    const menuStatus = async (token: string) => (await diner(qrMenu, 'qr-menu', token)).status;
    expect(await menuStatus(first.token)).toBe(404);
    expect(await menuStatus(regenerated)).toBe(200);
    expect(await menuStatus(second.token)).toBe(404);
    const patio = QrMenuResponse.parse((await diner(qrMenu, 'qr-menu', extra.token)).body);
    expect(patio.table.label).toBe('Patio 1');
  });

  it('refuses a table or a code listed twice', async () => {
    const hash = sha256(newTableToken()).toString('hex');
    const twice = await asServer('tables', {
      method: 'PUT',
      body: {
        tables: [
          { tableId: a.tables[0].id, label: 'T1', tokenHash: hash, active: true },
          { tableId: a.tables[1].id, label: 'T2', tokenHash: hash, active: true },
        ],
      },
    });
    expect(twice.status).toBe(400);
  });

  it('[QR-014] never touches another restaurant’s tables', async () => {
    await asServer('tables', {
      method: 'PUT',
      body: { tables: [] },
      credential: newTenantCredential,
    });
    expect((await diner(qrMenu, 'qr-menu', b.tables[0].token)).status).toBe(200);
  });
});

let newTenantCredential = '';
beforeAll(async () => {
  const tenant = await seedTenant(db, 'Empty Floor');
  newTenantCredential = tenant.credential;
  await publish(2, qrMenuDocument(), b.credential);
});

describe('[QR-009] picking up orders', () => {
  it('lists its own submitted orders, oldest first, until they are received', async () => {
    const tenant = await seedTenant(db, 'Pickup House');
    await publish(2, qrMenuDocument(), tenant.credential);
    const first = await placeOrder(tenant.tables[0].token);
    const second = await placeOrder(tenant.tables[1].token);
    await placeOrder(b.tables[0].token);
    const list = async () =>
      QrPickupResponse.parse(
        (await asServer('orders', { method: 'GET', credential: tenant.credential })).body,
      ).orders;
    const waiting = await list();
    // The seed's two orders were placed first.
    expect(waiting.map((order) => order.id).slice(-2)).toEqual([first, second]);
    expect(waiting.find((order) => order.id === first)).toMatchObject({
      tableId: tenant.tables[0].id,
      menuVersion: 2,
      lines: [{ itemId: IDS.dal, quantity: 1 }],
    });
    await setStatus(first, { status: 'RECEIVED' }, tenant.credential);
    expect((await list()).map((order) => order.id)).not.toContain(first);
  });
});

describe('[QR-007] what became of an order', () => {
  it('shows the diner each step the restaurant reports', async () => {
    await publish(30);
    const id = await placeOrder(a.tables[0].token);
    const view = async () =>
      QrOrderView.parse(
        (await diner(orderStatus, 'order-status', a.tables[0].token, undefined, `?id=${id}`)).body,
      );
    const received = await setStatus(id, { status: 'RECEIVED', localOrderId: randomUUID() });
    expect(UpdateQrOrderResponse.parse(received.body)).toEqual({ id, status: 'RECEIVED' });
    expect((await view()).status).toBe('RECEIVED');
    const clientLineId = (await view()).lines[0]!.clientLineId;
    await setStatus(id, {
      status: 'SENT_TO_KITCHEN',
      detail: { items: [{ clientLineId, state: 'PREPARING' }] },
    });
    expect(await view()).toMatchObject({
      status: 'SENT_TO_KITCHEN',
      detail: { items: [{ clientLineId, state: 'PREPARING' }] },
    });
    const backwards = await setStatus(id, { status: 'RECEIVED' });
    expect(backwards.status).toBe(409);
    expect(codeOf(backwards.body)).toBe('INVALID_STATUS_CHANGE');
  });

  it('tells the diner why the waiter rejected it', async () => {
    const id = await placeOrder(a.tables[0].token);
    await setStatus(id, { status: 'RECEIVED' });
    await setStatus(id, {
      status: 'REJECTED',
      detail: { rejectionReason: 'We have run out of dal' },
    });
    const view = QrOrderView.parse(
      (await diner(orderStatus, 'order-status', a.tables[0].token, undefined, `?id=${id}`)).body,
    );
    expect(view).toMatchObject({
      status: 'REJECTED',
      detail: { rejectionReason: 'We have run out of dal' },
    });
  });

  it('marks an order received too late as expired, and says so', async () => {
    const id = await placeOrder(a.tables[0].token);
    await letExpire(db, id);
    const late = await setStatus(id, { status: 'RECEIVED' });
    expect(late.status).toBe(410);
    expect(codeOf(late.body)).toBe('ORDER_EXPIRED');
    const { rows } = await db.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_orders WHERE id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('EXPIRED');
  });

  it('[QR-014] cannot touch another restaurant’s order', async () => {
    const theirs = await placeOrder(b.tables[0].token);
    const response = await setStatus(theirs, { status: 'RECEIVED' });
    expect(response.status).toBe(404);
    const { rows } = await db.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_orders WHERE id = $1',
      [theirs],
    );
    expect(rows[0]?.status).toBe('SUBMITTED');
    expect((await setStatus('not-an-id', { status: 'RECEIVED' })).status).toBe(400);
  });
});

describe('[QR-009] the Realtime session', () => {
  it('signs a short-lived token for its own restaurant’s order queue', async () => {
    const response = await asServer('session', { method: 'POST' });
    expect(response.status).toBe(200);
    const session = RelaySessionResponse.parse(response.body);
    expect(session).toMatchObject({
      tenantId: a.id,
      realtime: {
        apiKey: 'test-publishable-key',
        changes: [
          { event: 'INSERT', schema: 'relay', table: 'qr_orders', filter: `tenant_id=eq.${a.id}` },
          {
            event: 'INSERT',
            schema: 'relay',
            table: 'qr_service_requests',
            filter: `tenant_id=eq.${a.id}`,
          },
        ],
      },
    });
    const [header, payload, signature] = session.token.split('.');
    const expected = createHmac('sha256', JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ role: 'relay_server', tenant_id: a.id, sub: a.credentialId });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(SESSION_SECONDS);

    // What Realtime then lets the subscription see: this restaurant's orders only.
    const seen = await db.as(
      'relay_server',
      { tenant_id: String(claims.tenant_id) },
      async (client) =>
        (
          await client.query<{ tenant_id: string }>(
            'SELECT DISTINCT tenant_id::text FROM relay.qr_orders',
          )
        ).rows,
    );
    expect(seen).toEqual([{ tenant_id: a.id }]);
  });

  it('says to poll when Realtime is not set up', async () => {
    const response = await asServer('session', {
      method: 'POST',
      context: { ...context, realtimeJwtSecret: undefined },
    });
    expect(response.status).toBe(503);
    expect(codeOf(response.body)).toBe('REALTIME_NOT_CONFIGURED');
    const noKey = await asServer('session', {
      method: 'POST',
      context: { ...context, realtimeApiKey: undefined },
    });
    expect(codeOf(noKey.body)).toBe('REALTIME_NOT_CONFIGURED');
  });
});

/** A tiny WebP: "RIFF", the length, "WEBP", then a chunk. */
function webp(marker: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set([24, 0, 0, 0], 4);
  bytes.set(new TextEncoder().encode('WEBPVP8L'), 8);
  bytes[31] = marker;
  return bytes;
}

async function upload(
  photoId: string,
  width: number,
  bytes: Uint8Array,
  options: { credential?: string; contentType?: string; context?: FunctionContext } = {},
) {
  const response = await server(
    new Request(
      `https://relay.example.invalid/functions/v1/server/photos/${photoId}/${String(width)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${options.credential ?? a.credential}`,
          'content-type': options.contentType ?? 'image/webp',
        },
        body: bytes,
      },
    ),
    options.context ?? context,
  );
  const body: unknown = await response.json();
  return { status: response.status, body };
}

const sweep = (inUse: string[], credential?: string) =>
  asServer('photos/sweep', { method: 'POST', body: { inUse }, credential });

async function photoRow(tenantId: string, photoId: string) {
  const { rows } = await db.admin.query<{ removed_at: Date | null; purged_at: Date | null }>(
    'SELECT removed_at, purged_at FROM relay.photos WHERE tenant_id = $1 AND photo_id = $2',
    [tenantId, photoId],
  );
  return rows[0];
}

describe('[MENU-008] menu photos', () => {
  it('stores each size under the restaurant’s own folder and tells the QR page where', async () => {
    const photoId = randomUUID();
    for (const width of [160, 480, 960]) {
      const response = await upload(photoId, width, webp(width % 251));
      expect(response.status).toBe(200);
      expect(RelayPhotoUploadResponse.parse(response.body).path).toBe(
        `${a.id}/${photoId}/${String(width)}.webp`,
      );
    }
    expect(bucket.get(`${a.id}/${photoId}/480.webp`)?.[31]).toBe(480 % 251);
    // Sent again (a new photo for the dish): replaced in place.
    await upload(photoId, 480, webp(7));
    expect(bucket.get(`${a.id}/${photoId}/480.webp`)?.[31]).toBe(7);
    expect(await photoRow(a.id, photoId)).toMatchObject({ removed_at: null, purged_at: null });

    await publish(900);
    const menu = await diner(qrMenu, 'qr-menu', a.tables[0].token);
    expect(QrMenuResponse.parse(menu.body).photoBase).toBe(photoStorage.publicBase);
    const off = await call(qrMenu, 'qr-menu', {
      method: 'GET',
      credential: null,
      headers: { [TABLE_TOKEN_HEADER]: a.tables[0].token },
      context: { ...context, photos: undefined },
    });
    expect(QrMenuResponse.parse(off.body).photoBase).toBeNull();
  });

  it('takes WebP files of the known sizes only, and not too large', async () => {
    const photoId = randomUUID();
    expect((await upload(photoId, 320, webp(1))).status).toBe(400);
    expect((await upload('not-a-photo', 160, webp(1))).status).toBe(400);
    const jpeg = await upload(photoId, 160, webp(1), { contentType: 'image/jpeg' });
    expect(jpeg.status).toBe(415);
    const fake = await upload(photoId, 160, new TextEncoder().encode('<svg onload="x()"></svg>'));
    expect(fake.status).toBe(415);
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    huge.set(webp(1));
    expect((await upload(photoId, 960, huge)).status).toBe(413);
    expect((await upload(photoId, 160, webp(1), { credential: newCredential() })).status).toBe(401);
    const off = await upload(photoId, 160, webp(1), { context: { ...context, photos: undefined } });
    expect(off.status).toBe(503);
    expect(codeOf(off.body)).toBe('PHOTOS_OFF');
    expect(await photoRow(a.id, photoId)).toBeUndefined();
    expect([...bucket.keys()].some((path) => path.includes(photoId))).toBe(false);
  });

  it('[QR-014] keeps one restaurant’s photos apart from another’s', async () => {
    const photoId = randomUUID();
    await upload(photoId, 160, webp(1), { credential: b.credential });
    expect(bucket.has(`${b.id}/${photoId}/160.webp`)).toBe(true);
    expect(await photoRow(a.id, photoId)).toBeUndefined();
    // A's sweep never marks B's photo.
    await sweep([]);
    expect(await photoRow(b.id, photoId)).toMatchObject({ removed_at: null });
  });

  it('[BRD §9.3] removes a photo’s files 90 days after the menu stops using it', async () => {
    const kept = randomUUID();
    const dropped = randomUUID();
    const back = randomUUID();
    for (const photoId of [kept, dropped, back]) {
      for (const width of [160, 480, 960]) await upload(photoId, width, webp(1));
    }
    const first = RelayPhotoSweepResponse.parse((await sweep([kept, back])).body);
    expect(first.purged).toBe(0);
    expect(first.missing).toEqual([]);
    const dropMore = RelayPhotoSweepResponse.parse((await sweep([kept])).body);
    expect(dropMore.removed).toBe(1);
    expect((await photoRow(a.id, back))?.removed_at).not.toBeNull();
    // The dish takes its photo back within the 90 days: nothing to send again.
    const restored = RelayPhotoSweepResponse.parse((await sweep([kept, back])).body);
    expect(restored).toMatchObject({ restored: 1, missing: [] });

    // 89 days on, the dropped photo's files are still there; at 91 they are gone.
    await db.admin.query(
      `UPDATE relay.photos SET removed_at = now() - interval '89 days'
       WHERE tenant_id = $1 AND photo_id = $2`,
      [a.id, dropped],
    );
    expect(RelayPhotoSweepResponse.parse((await sweep([kept, back])).body).purged).toBe(0);
    expect(bucket.has(`${a.id}/${dropped}/960.webp`)).toBe(true);
    await db.admin.query(
      `UPDATE relay.photos SET removed_at = now() - interval '91 days'
       WHERE tenant_id = $1 AND photo_id = $2`,
      [a.id, dropped],
    );
    expect(RelayPhotoSweepResponse.parse((await sweep([kept, back])).body).purged).toBe(1);
    for (const width of [160, 480, 960]) {
      expect(bucket.has(`${a.id}/${dropped}/${String(width)}.webp`)).toBe(false);
    }
    expect(bucket.has(`${a.id}/${kept}/960.webp`)).toBe(true);
    // The record stays; a menu wanting the photo again is told to send it.
    expect((await photoRow(a.id, dropped))?.purged_at).not.toBeNull();
    const again = RelayPhotoSweepResponse.parse((await sweep([kept, back, dropped])).body);
    expect(again).toMatchObject({ restored: 0, missing: [dropped] });
    await upload(dropped, 160, webp(2));
    expect(await photoRow(a.id, dropped)).toMatchObject({ removed_at: null, purged_at: null });
  });

  it('refuses a sweep without the credential or with a bad list', async () => {
    expect((await sweep([], newCredential())).status).toBe(401);
    const bad = await asServer('photos/sweep', { method: 'POST', body: { inUse: ['nope'] } });
    expect(bad.status).toBe(400);
  });
});
