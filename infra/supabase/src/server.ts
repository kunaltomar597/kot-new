import {
  PublishQrMenuRequest,
  type PublishQrMenuResponse,
  type QrPickupOrder,
  QrOrderParams,
  type QrPickupServiceRequest,
  QrServiceRequestParams,
  UpdateQrServiceRequest,
  type UpdateQrServiceRequestResponse,
  RelayCredential,
  RelayPresenceRequest,
  type RelayPresenceResponse,
  type RelaySessionResponse,
  SyncRelayTablesRequest,
  type SyncRelayTablesResponse,
  UpdateQrOrderRequest,
  type UpdateQrOrderResponse,
} from '@rp/contracts/relay';
import { actAsServer, isoUtc, type Tx } from './db.js';
import {
  type FunctionContext,
  HttpError,
  json,
  readBody,
  serveRoutes,
  sqlStateOf,
} from './http.js';
import { signHs256 } from './jwt.js';

/**
 * The `server` function (P5-02b): what a restaurant's local server does at the relay, each call
 * with its credential (VCP-002). Every write acts as `relay_writer` for that restaurant only, so
 * Row-Level Security keeps it inside its own rows (SEC-005, QR-014).
 */

/** How long a Realtime session lasts; the sync agent renews it before then. */
export const SESSION_SECONDS = 3_600;

interface ServerScope {
  readonly tenantId: string;
  readonly credentialId: string;
}

/** Checks the credential and acts for its restaurant's local server. */
async function openServer(tx: Tx, request: Request): Promise<ServerScope> {
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '');
  const credential = RelayCredential.safeParse(match?.[1]);
  const rejected = new HttpError(
    401,
    'CREDENTIAL_REJECTED',
    'The relay credential was not accepted.',
  );
  if (!credential.success) throw rejected;
  const [row] = await tx.query<{ tenant_id: string; credential_id: string }>(
    'SELECT tenant_id, credential_id FROM relay.verify_credential($1)',
    [credential.data],
  );
  if (row === undefined) throw rejected;
  await actAsServer(tx, row.tenant_id);
  return { tenantId: row.tenant_id, credentialId: row.credential_id };
}

/** QR-009: a token for the Realtime channel of this restaurant's new orders. */
async function session(request: Request, context: FunctionContext): Promise<Response> {
  const scope = await context.db.transaction((tx) => openServer(tx, request));
  const secret = context.realtimeJwtSecret;
  if (secret === undefined || secret === '') {
    throw new HttpError(
      503,
      'REALTIME_NOT_CONFIGURED',
      'Realtime is not set up for this relay; poll for orders instead.',
    );
  }
  const issuedAt = Math.floor(context.now().getTime() / 1000);
  const expiresAt = issuedAt + SESSION_SECONDS;
  const token = await signHs256(
    {
      iss: 'rp-relay',
      sub: scope.credentialId,
      role: 'relay_server',
      tenant_id: scope.tenantId,
      iat: issuedAt,
      exp: expiresAt,
    },
    secret,
  );
  const body: RelaySessionResponse = {
    tenantId: scope.tenantId,
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    realtime: { schema: 'relay', table: 'qr_orders', filter: `tenant_id=eq.${scope.tenantId}` },
  };
  return json(200, body);
}

/** QR-008: the local server is here; the QR settings it sends apply from the next order. */
async function presence(request: Request, context: FunctionContext): Promise<Response> {
  const body = await readBody(request, RelayPresenceRequest);
  const serverTime = await context.db.transaction(async (tx) => {
    const { tenantId } = await openServer(tx, request);
    const { settings } = body;
    await tx.query(
      `INSERT INTO relay.presence (tenant_id, server_version) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET server_version = excluded.server_version`,
      [tenantId, body.serverVersion],
    );
    await tx.query(
      `INSERT INTO relay.tenant_settings (tenant_id, submissions_per_window,
         rate_limit_window_minutes, pickup_timeout_seconds, presence_interval_seconds,
         read_only_after_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         submissions_per_window = excluded.submissions_per_window,
         rate_limit_window_minutes = excluded.rate_limit_window_minutes,
         pickup_timeout_seconds = excluded.pickup_timeout_seconds,
         presence_interval_seconds = excluded.presence_interval_seconds,
         read_only_after_seconds = excluded.read_only_after_seconds`,
      [
        tenantId,
        settings.submissionsPerWindow,
        settings.rateLimitWindowMinutes,
        settings.pickupTimeoutSeconds,
        settings.presenceIntervalSeconds,
        settings.readOnlyAfterSeconds,
      ],
    );
    const [row] = await tx.query<{ now: string }>(`SELECT ${isoUtc('now()')} AS now`);
    return row?.now ?? new Date().toISOString();
  });
  const answer: RelayPresenceResponse = { serverTime };
  return json(200, answer);
}

/** QR-003: a new publication of the QR menu. Versions only grow; a retry is a replay. */
async function publishMenu(request: Request, context: FunctionContext): Promise<Response> {
  const body = await readBody(request, PublishQrMenuRequest);
  const answer = await context.db.transaction(async (tx): Promise<PublishQrMenuResponse> => {
    const { tenantId } = await openServer(tx, request);
    // One publication at a time per restaurant, so versions are compared and stored in order.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('relay.menu:' || $1, 0))", [
      tenantId,
    ]);
    const document = JSON.stringify(body.document);
    const [latest] = await tx.query<{ version: number | null; same: boolean | null }>(
      `SELECT max(version)::int AS version,
              bool_or(version = $2 AND menu = $3::text::jsonb) AS same
       FROM relay.menu_snapshots WHERE tenant_id = $1`,
      [tenantId, body.version, document],
    );
    if (latest?.same === true) return { version: body.version, replayed: true };
    const latestVersion = latest?.version ?? null;
    if (latestVersion !== null && body.version <= latestVersion) {
      throw new HttpError(409, 'STALE_MENU_VERSION', 'A newer menu is already published.', {
        latest: latestVersion,
      });
    }
    await tx.query(
      'INSERT INTO relay.menu_snapshots (tenant_id, version, menu) VALUES ($1, $2, $3::text::jsonb)',
      [tenantId, body.version, document],
    );
    return { version: body.version, replayed: false };
  });
  return json(200, answer);
}

/** QR-001: every table with its QR token's hash; the ones left out go out of service. */
async function syncTables(request: Request, context: FunctionContext): Promise<Response> {
  const { tables } = await readBody(request, SyncRelayTablesRequest);
  const ids = tables.map((table) => table.tableId);
  const hashes = tables.flatMap((table) => (table.tokenHash === null ? [] : [table.tokenHash]));
  if (new Set(ids).size !== ids.length || new Set(hashes).size !== hashes.length) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Each table and each QR code may appear once.');
  }
  const answer = await context.db.transaction(async (tx): Promise<SyncRelayTablesResponse> => {
    const { tenantId } = await openServer(tx, request);
    await tx
      .query(
        `INSERT INTO relay.dining_tables (tenant_id, table_id, label, token_hash, active)
       SELECT $1, t.table_id, t.label, decode(t.token_hash, 'hex'), t.active
       FROM jsonb_to_recordset($2::text::jsonb)
         AS t(table_id uuid, label text, token_hash text, active boolean)
       ON CONFLICT (tenant_id, table_id) DO UPDATE SET
         label = excluded.label, token_hash = excluded.token_hash, active = excluded.active`,
        [
          tenantId,
          JSON.stringify(
            tables.map((table) => ({
              table_id: table.tableId,
              label: table.label,
              token_hash: table.tokenHash,
              active: table.active,
            })),
          ),
        ],
      )
      .catch((error: unknown) => {
        // 128 random bits never collide by chance: the hash is another restaurant's code.
        if (sqlStateOf(error) === '23505') {
          throw new HttpError(409, 'TOKEN_HASH_TAKEN', 'A QR code hash is already in use.');
        }
        throw error;
      });
    const deactivated = await tx.query(
      `UPDATE relay.dining_tables SET active = false
       WHERE tenant_id = $1 AND active AND NOT (table_id = ANY($2::text::uuid[]))
       RETURNING table_id`,
      [tenantId, `{${ids.join(',')}}`],
    );
    const [counts] = await tx.query<{ with_code: number }>(
      `SELECT count(*)::int AS with_code FROM relay.dining_tables
       WHERE tenant_id = $1 AND active AND token_hash IS NOT NULL`,
      [tenantId],
    );
    return { withCode: counts?.with_code ?? 0, deactivated: deactivated.length };
  });
  return json(200, answer);
}

/** QR-009: orders waiting to be picked up, oldest first (the polling fallback). */
async function pickup(request: Request, context: FunctionContext): Promise<Response> {
  const orders = await context.db.transaction(async (tx) => {
    await openServer(tx, request);
    return tx.query<{
      id: string;
      table_id: string;
      idempotency_key: string;
      lines: QrPickupOrder['lines'];
      instructions: string | null;
      customer_name: string | null;
      version: number;
      submitted_at: string;
      expires_at: string;
    }>(
      `SELECT id, table_id, idempotency_key, lines, instructions, customer_name,
              snapshot_version::int AS version,
              ${isoUtc('submitted_at')} AS submitted_at, ${isoUtc('expires_at')} AS expires_at
       FROM relay.qr_orders
       WHERE status = 'SUBMITTED' AND expires_at >= now()
       ORDER BY submitted_at, id LIMIT 100`,
    );
  });
  return json(200, {
    orders: orders.map((row): QrPickupOrder => ({
      id: row.id,
      tableId: row.table_id,
      idempotencyKey: row.idempotency_key,
      lines: row.lines,
      orderNote: row.instructions,
      customerName: row.customer_name,
      menuVersion: row.version,
      submittedAt: row.submitted_at,
      expiresAt: row.expires_at,
    })),
  });
}

/**
 * QR-007: what became of an order. Receiving one past its pickup time marks it expired instead,
 * and says so, so the restaurant rejects it.
 */
async function updateOrder(
  request: Request,
  context: FunctionContext,
  match: RegExpExecArray,
): Promise<Response> {
  const params = QrOrderParams.safeParse({ orderId: match[1] });
  if (!params.success) throw new HttpError(400, 'VALIDATION_FAILED', 'Unknown order id.');
  const body = await readBody(request, UpdateQrOrderRequest);
  const outcome = await context.db.transaction(
    async (tx): Promise<UpdateQrOrderResponse | 'EXPIRED' | 'NOT_FOUND'> => {
      await openServer(tx, request);
      try {
        const [row] = await tx.savepoint((change) =>
          change.query<UpdateQrOrderResponse>(
            `UPDATE relay.qr_orders SET status = $2,
             status_detail = coalesce($3::text::jsonb, status_detail),
             local_order_id = coalesce($4::uuid, local_order_id)
           WHERE id = $1 RETURNING id, status`,
            [
              params.data.orderId,
              body.status,
              body.detail === undefined ? null : JSON.stringify(body.detail),
              body.localOrderId ?? null,
            ],
          ),
        );
        return row ?? 'NOT_FOUND';
      } catch (error) {
        if (sqlStateOf(error) === 'RL409') {
          throw new HttpError(409, 'INVALID_STATUS_CHANGE', 'The order cannot move that way.');
        }
        if (sqlStateOf(error) !== 'RL410') throw error;
        // Too late to receive: the relay marks it expired, and that is kept.
        await tx.query(
          "UPDATE relay.qr_orders SET status = 'EXPIRED' WHERE id = $1 AND status = 'SUBMITTED'",
          [params.data.orderId],
        );
        return 'EXPIRED';
      }
    },
  );
  if (outcome === 'NOT_FOUND') {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'No such order of this restaurant.');
  }
  if (outcome === 'EXPIRED') {
    throw new HttpError(
      410,
      'ORDER_EXPIRED',
      'The order was not picked up in time; it has expired.',
    );
  }
  return json(200, outcome);
}

/** QR-011: diners' requests waiting to be picked up, oldest first. */
async function pickupRequests(request: Request, context: FunctionContext): Promise<Response> {
  const rows = await context.db.transaction(async (tx) => {
    await openServer(tx, request);
    return tx.query<{
      id: string;
      table_id: string;
      type: QrPickupServiceRequest['type'];
      submitted_at: string;
      expires_at: string;
    }>(
      `SELECT id, table_id, type,
              ${isoUtc('submitted_at')} AS submitted_at, ${isoUtc('expires_at')} AS expires_at
       FROM relay.qr_service_requests
       WHERE status = 'SUBMITTED' AND expires_at >= now()
       ORDER BY submitted_at, id LIMIT 100`,
    );
  });
  return json(200, {
    requests: rows.map((row): QrPickupServiceRequest => ({
      id: row.id,
      tableId: row.table_id,
      type: row.type,
      submittedAt: row.submitted_at,
      expiresAt: row.expires_at,
    })),
  });
}

/** QR-011: what became of a diner's request; receiving one too late marks it expired. */
async function updateRequest(
  request: Request,
  context: FunctionContext,
  match: RegExpExecArray,
): Promise<Response> {
  const params = QrServiceRequestParams.safeParse({ requestId: match[1] });
  if (!params.success) throw new HttpError(400, 'VALIDATION_FAILED', 'Unknown request id.');
  const body = await readBody(request, UpdateQrServiceRequest);
  const outcome = await context.db.transaction(
    async (tx): Promise<UpdateQrServiceRequestResponse | 'EXPIRED' | 'NOT_FOUND'> => {
      await openServer(tx, request);
      try {
        const [row] = await tx.savepoint((change) =>
          change.query<UpdateQrServiceRequestResponse>(
            `UPDATE relay.qr_service_requests SET status = $2,
               rejection_reason = coalesce($3, rejection_reason)
             WHERE id = $1 RETURNING id, status`,
            [params.data.requestId, body.status, body.rejectionReason ?? null],
          ),
        );
        return row ?? 'NOT_FOUND';
      } catch (error) {
        if (sqlStateOf(error) === 'RL409') {
          throw new HttpError(409, 'INVALID_STATUS_CHANGE', 'The request cannot move that way.');
        }
        if (sqlStateOf(error) !== 'RL410') throw error;
        await tx.query(
          "UPDATE relay.qr_service_requests SET status = 'EXPIRED' WHERE id = $1 AND status = 'SUBMITTED'",
          [params.data.requestId],
        );
        return 'EXPIRED';
      }
    },
  );
  if (outcome === 'NOT_FOUND') {
    throw new HttpError(404, 'REQUEST_NOT_FOUND', 'No such request of this restaurant.');
  }
  if (outcome === 'EXPIRED') {
    throw new HttpError(410, 'REQUEST_EXPIRED', 'The request was not picked up in time.');
  }
  return json(200, outcome);
}

export const server = serveRoutes([
  { method: 'POST', path: /\/server\/session$/, handler: session },
  { method: 'POST', path: /\/server\/presence$/, handler: presence },
  { method: 'PUT', path: /\/server\/menu$/, handler: publishMenu },
  { method: 'PUT', path: /\/server\/tables$/, handler: syncTables },
  { method: 'GET', path: /\/server\/orders$/, handler: pickup },
  { method: 'POST', path: /\/server\/orders\/([^/]+)\/status$/, handler: updateOrder },
  { method: 'GET', path: /\/server\/service-requests$/, handler: pickupRequests },
  {
    method: 'POST',
    path: /\/server\/service-requests\/([^/]+)\/status$/,
    handler: updateRequest,
  },
]);
