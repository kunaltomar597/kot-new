import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import pg from 'pg';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * A stand-in for Supabase Realtime's postgres_changes, enough for a local server's doorbell
 * (P5-03d): the Phoenix socket at `/realtime/v1/websocket` (protocol 1.0.0, JSON), joins with an
 * access token checked like Supabase checks it (HS256 with the project's secret, not expired),
 * heartbeats, token refresh, and INSERTs on the relay's queues delivered after commit to the
 * subscribers whose token's restaurant owns the row (RLS for `relay_server`). Changes come from a
 * trigger and NOTIFY in the test database only, never from a relay migration.
 */

const NOTIFY_CHANNEL = 'rp_test_realtime';
const TABLES = ['qr_orders', 'qr_service_requests'] as const;

/** What the test database's trigger reports: enough to route it, not the whole row. */
interface Change {
  readonly schema: string;
  readonly table: string;
  readonly type: string;
  readonly record: { readonly id: string; readonly tenant_id: string } & Record<string, unknown>;
}

interface Binding {
  readonly id: number;
  readonly event: string;
  readonly schema: string;
  readonly table: string;
  readonly filter?: string;
}

interface Joined {
  readonly topic: string;
  readonly joinRef: string | null;
  readonly bindings: readonly Binding[];
  tenantId: string;
  expiresAt: number;
}

interface Message {
  readonly topic: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly ref: string | null;
  readonly join_ref?: string | null;
}

export interface FakeRealtime {
  /** Hands an HTTP upgrade at the socket's path to the stand-in; false for any other path. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Sockets with at least one joined channel. */
  readonly subscribers: number;
  /** Drops every socket (an internet cut). */
  dropAll(): void;
  close(): Promise<void>;
}

/** Installs the change trigger in the test relay's database. */
async function installTrigger(admin: pg.Pool): Promise<void> {
  await admin.query(`
    CREATE SCHEMA IF NOT EXISTS rp_test;
    CREATE OR REPLACE FUNCTION rp_test.realtime_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
    BEGIN
      PERFORM pg_notify('${NOTIFY_CHANNEL}', json_build_object(
        'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'type', TG_OP,
        'record', json_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id,
          'table_id', NEW.table_id, 'status', NEW.status))::text);
      RETURN NEW;
    END
    $$;`);
  for (const table of TABLES) {
    await admin.query(`
      DROP TRIGGER IF EXISTS rp_test_realtime ON relay.${table};
      CREATE TRIGGER rp_test_realtime AFTER INSERT ON relay.${table}
        FOR EACH ROW EXECUTE FUNCTION rp_test.realtime_change();`);
  }
}

/** The claims of an HS256 token signed with `secret`, or why it is refused. */
function verify(token: unknown, secret: string): Record<string, unknown> | string {
  if (typeof token !== 'string') return 'No access token';
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    return 'Invalid JWT';
  }
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return 'Invalid JWT signature';
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return 'Token has expired';
  return claims;
}

export async function startFakeRealtime(options: {
  readonly admin: pg.Pool;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly apiKey: string;
}): Promise<FakeRealtime> {
  await installTrigger(options.admin);
  const sockets = new Map<WebSocket, Map<string, Joined>>();
  const server = new WebSocketServer({ noServer: true });
  let nextBindingId = 1000;

  const send = (socket: WebSocket, message: Message) => {
    socket.send(JSON.stringify(message));
  };
  const reply = (socket: WebSocket, message: Message, status: 'ok' | 'error', response: object) => {
    send(socket, {
      topic: message.topic,
      event: 'phx_reply',
      payload: { status, response },
      ref: message.ref,
      join_ref: message.join_ref ?? null,
    });
  };

  const onMessage = (socket: WebSocket, joined: Map<string, Joined>, message: Message) => {
    if (message.topic === 'phoenix' && message.event === 'heartbeat') {
      reply(socket, message, 'ok', {});
      return;
    }
    if (message.event === 'phx_join') {
      const claims = verify(message.payload.access_token, options.jwtSecret);
      if (typeof claims === 'string') {
        reply(socket, message, 'error', { reason: claims });
        return;
      }
      const config = (message.payload.config ?? {}) as { postgres_changes?: unknown };
      const wanted = Array.isArray(config.postgres_changes) ? config.postgres_changes : [];
      const bindings = wanted.map((binding): Binding => ({
        ...(binding as Omit<Binding, 'id'>),
        id: nextBindingId++,
      }));
      joined.set(message.topic, {
        topic: message.topic,
        joinRef: message.join_ref ?? message.ref,
        bindings,
        tenantId: String(claims.tenant_id),
        expiresAt: Number(claims.exp) * 1000,
      });
      reply(socket, message, 'ok', { postgres_changes: bindings });
      send(socket, {
        topic: message.topic,
        event: 'system',
        payload: {
          channel: message.topic.replace(/^realtime:/, ''),
          extension: 'postgres_changes',
          message: 'Subscribed to PostgreSQL',
          status: 'ok',
        },
        ref: null,
      });
      return;
    }
    const channel = joined.get(message.topic);
    if (channel === undefined) return;
    if (message.event === 'access_token') {
      const claims = verify(message.payload.access_token, options.jwtSecret);
      if (typeof claims === 'string') return;
      channel.tenantId = String(claims.tenant_id);
      channel.expiresAt = Number(claims.exp) * 1000;
      return;
    }
    if (message.event === 'phx_leave') {
      joined.delete(message.topic);
      reply(socket, message, 'ok', {});
    }
  };

  server.on('connection', (socket: WebSocket) => {
    const joined = new Map<string, Joined>();
    sockets.set(socket, joined);
    socket.on('message', (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(new Uint8Array(data)).toString('utf8');
      let message: Message;
      try {
        message = JSON.parse(text) as Message;
      } catch {
        socket.close(1003, 'Not JSON');
        return;
      }
      onMessage(socket, joined, message);
    });
    socket.on('close', () => sockets.delete(socket));
  });

  // Changes reach subscribers after commit, as Realtime streams them from the WAL.
  const listener = new pg.Client({ connectionString: options.databaseUrl });
  await listener.connect();
  await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
  listener.on('notification', (notification) => {
    if (notification.payload === undefined) return;
    const change = JSON.parse(notification.payload) as Change;
    for (const [socket, joined] of sockets) {
      for (const channel of joined.values()) {
        if (channel.expiresAt <= Date.now()) {
          // Supabase closes a channel whose token ran out.
          joined.delete(channel.topic);
          send(socket, {
            topic: channel.topic,
            event: 'system',
            payload: { extension: 'system', message: 'Token has expired', status: 'error' },
            ref: null,
          });
          send(socket, { topic: channel.topic, event: 'phx_close', payload: {}, ref: null });
          continue;
        }
        // RLS for relay_server: its own restaurant's rows only.
        if (change.record.tenant_id !== channel.tenantId) continue;
        const ids = channel.bindings
          .filter(
            (binding) =>
              (binding.event === '*' || binding.event === change.type) &&
              binding.schema === change.schema &&
              binding.table === change.table &&
              (binding.filter === undefined ||
                binding.filter === `tenant_id=eq.${change.record.tenant_id}`),
          )
          .map((binding) => binding.id);
        if (ids.length === 0) continue;
        send(socket, {
          topic: channel.topic,
          event: 'postgres_changes',
          payload: {
            ids,
            data: {
              schema: change.schema,
              table: change.table,
              type: change.type,
              commit_timestamp: new Date().toISOString(),
              record: change.record,
              columns: [],
              errors: null,
            },
          },
          ref: null,
        });
      }
    }
  });

  return {
    upgrade(request, socket, head) {
      const url = new URL(request.url ?? '/', 'http://relay.invalid');
      if (url.pathname !== '/realtime/v1/websocket') return false;
      if (url.searchParams.get('apikey') !== options.apiKey) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return true;
      }
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit('connection', ws, request);
      });
      return true;
    },
    get subscribers() {
      return [...sockets.values()].filter((joined) => joined.size > 0).length;
    },
    dropAll() {
      for (const socket of sockets.keys()) socket.terminate();
    },
    async close() {
      for (const socket of sockets.keys()) socket.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await listener.end();
    },
  };
}
