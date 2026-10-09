import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import {
  BROWSER_ID_HEADER,
  type QrMenuDocument,
  QrMenuResponse,
  QrOrderView,
  QrSubmitOrderResponse,
  type QrSubmitOrderRequest,
  TABLE_TOKEN_HEADER,
} from '@rp/contracts/relay';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { TableQrService } from '../../src/floor/table-qr.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import { countError, type DeviceMetrics } from './device.js';
import type { LoadRestaurant } from './restaurant.js';
import { type SlowLine, startSlowLine } from './slow-line.js';

/**
 * The QR side of the load run (P8-01b, NFR-P05, NFR-P06): the QR relay with its functions and a
 * stand-in for Supabase Realtime (`@rp/relay/testing`), behind two internet lines, and diners'
 * phones with a table's QR page open, doing what the QR site does.
 */

/** A phone on 4G: 150 ms there and back, Lighthouse's mobile profile (as NFR-P12's test). */
export const DINERS_ONE_WAY_MS = 75;
/** The restaurant's broadband to the relay's region (Supabase, Mumbai): 40 ms there and back. */
export const RESTAURANT_ONE_WAY_MS = 20;

/** Test only: the relay signs Realtime sessions with it, its stand-in checks them. */
const REALTIME_SECRET = 'load-test-only-realtime-secret-0123456789';

export interface QrRelay {
  readonly relay: TestRelay;
  /** The functions' address as the restaurant's server reaches it (`RP_RELAY_URL`). */
  readonly serverUrl: string;
  /** The functions' address as diners' phones reach it. */
  readonly dinersUrl: string;
  readonly tenantId: string;
  readonly credential: string;
  stop(): Promise<void>;
}

/** Starts the relay in the cluster at `adminUrl`, with one restaurant provisioned. */
export async function startQrRelay(options: {
  readonly adminUrl: string;
  readonly runId: string;
}): Promise<QrRelay> {
  const relay = await startRelay({ ...options, realtimeJwtSecret: REALTIME_SECRET });
  const tenant = await relay.provision('Load test restaurant');
  const port = Number(new URL(relay.baseUrl).port);
  const lines: SlowLine[] = [
    await startSlowLine({ host: '127.0.0.1', port }, RESTAURANT_ONE_WAY_MS),
    await startSlowLine({ host: '127.0.0.1', port }, DINERS_ONE_WAY_MS),
  ];
  const through = (line: SlowLine | undefined) =>
    `http://127.0.0.1:${String(line?.port ?? 0)}/functions/v1`;
  return {
    relay,
    serverUrl: through(lines[0]),
    dinersUrl: through(lines[1]),
    tenantId: tenant.tenantId,
    credential: tenant.credential,
    async stop() {
      await Promise.all(lines.map((line) => line.stop()));
      await relay.stop();
    },
  };
}

/**
 * Connects the restaurant to the relay as support does (P5-03): the relay's credential sealed in
 * its database, and a QR code on every table (QR-001). Returns each table's code by table id. The
 * server starts its sync once it runs with `RP_RELAY_URL`.
 */
export async function connectQr(
  app: INestApplication,
  restaurant: LoadRestaurant,
  credential: string,
): Promise<Record<string, string>> {
  const prisma = app.get(PrismaService);
  await saveRelayCredential(prisma, app.get<SecretStore>(SECRET_STORE), credential);
  const manager = restaurant.people.managers[0];
  const dashboard = restaurant.devices.find((device) => device.kind === 'DASHBOARD');
  if (manager === undefined || dashboard === undefined) throw new Error('No manager or dashboard');
  await app.get(TableQrService).issueMissing({
    staffId: manager.staffId,
    role: 'MANAGER',
    restaurantId: restaurant.restaurantId,
    deviceId: dashboard.deviceId,
    sessionId: randomUUID(),
    secondFactorAt: null,
    capabilities: [],
  });
  const tables = await prisma.diningTable.findMany({
    where: { restaurantId: restaurant.restaurantId },
    select: { id: true, qrToken: true },
  });
  return Object.fromEntries(tables.map((table) => [table.id, table.qrToken ?? '']));
}

/**
 * Waits until the server is in step with the relay: present, its menu and tables published, and
 * its Realtime doorbell rung by new orders (P5-03d). The sync starts some seconds after the
 * server; the rush must not start before.
 */
export async function qrReady(qr: QrRelay, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const { rows } = await qr.relay.admin.query<{ ready: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM relay.presence WHERE tenant_id = $1)
          AND EXISTS (SELECT 1 FROM relay.menu_snapshots WHERE tenant_id = $1)
          AND EXISTS (SELECT 1 FROM relay.dining_tables WHERE tenant_id = $1) AS ready`,
      [qr.tenantId],
    );
    if (rows[0]?.ready === true && (qr.relay.realtime?.subscribers ?? 0) > 0) return;
    if (performance.now() > deadline) {
      throw new Error('The server did not get in step with the QR relay in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** An availability change as the run records it. */
export interface AvailabilityChange {
  readonly itemId: string;
  readonly available: boolean;
  /** `performance.now()` when the manager made it. */
  readonly startedAt: number;
}

/**
 * Whether a QR page's menu, as it stood at `at`, is in step with `change` (NFR-P05): the dish
 * shows the change, or a later change of the same dish had begun by then. In the second case the
 * page never showed this change; it counts from when the page next looked, which is past the 30 s
 * when the changes are 30 s apart.
 */
export function inStepWith(
  menu: QrMenuDocument,
  change: AvailabilityChange,
  changes: readonly AvailabilityChange[],
  at: number,
): boolean {
  const shown = menu.menu.items.find((item) => item.id === change.itemId)?.available;
  return (
    shown === change.available ||
    changes.some(
      (later) =>
        later.itemId === change.itemId &&
        later.startedAt > change.startedAt &&
        later.startedAt <= at,
    )
  );
}

class RelayCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`The relay answered ${String(status)} ${code}`);
  }
}

type LoadedMenu = QrMenuResponse & { readonly document: QrMenuDocument };

const MenuEnvelope = QrMenuResponse.omit({ document: true });

/**
 * A diner's phone with a table's QR page open (P8-01b), making the QR site's calls: the whole menu
 * when it opens, then `?known=` every `refreshMs` (QR_MENU_REFRESH_MS), and each order on its way
 * every QR_ORDER_POLL_MS. Calls are timed under `relay <function>`.
 */
export class QrPage {
  private loaded: LoadedMenu | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners: ((page: QrPage, at: number) => void)[] = [];
  private readonly browserId = randomBytes(16).toString('base64url');
  closed = false;

  constructor(
    readonly tableId: string,
    private readonly options: {
      readonly url: string;
      readonly token: string;
      readonly refreshMs: number;
      readonly metrics: DeviceMetrics;
    },
  ) {}

  /** The menu the page shows. */
  get menu(): QrMenuDocument | undefined {
    return this.loaded?.document;
  }

  /** After every answer about the menu, changed or not, with when it arrived. */
  onMenu(listener: (page: QrPage, at: number) => void): void {
    this.listeners.push(listener);
  }

  /** Opens the page; it then asks again every `refreshMs`, the first time after `firstMs`. */
  async open(firstMs: number): Promise<void> {
    await this.refresh();
    const tick = () => {
      if (this.closed) return;
      this.timer = setTimeout(tick, this.options.refreshMs);
      this.refresh().catch(() => undefined);
    };
    if (!this.closed) this.timer = setTimeout(tick, firstMs);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** Asks whether the menu changed (the whole of it the first time). */
  async refresh(): Promise<void> {
    const known = this.loaded?.version;
    const answer = await this.call(
      'qr-menu',
      `qr-menu${known === undefined ? '' : `?known=${String(known)}`}`,
      { method: 'GET' },
      // The envelope is checked; the menu (1,000 dishes) was checked when it was published, and
      // checking it again on every page would keep this process busy enough to skew the figures.
      (body) => ({
        ...MenuEnvelope.parse(body),
        document: (body as { document: QrMenuDocument | null }).document,
      }),
    );
    const at = performance.now();
    const document = answer.document ?? this.loaded?.document;
    if (document === undefined) throw new Error('The relay sent no menu');
    this.loaded = { ...answer, document };
    for (const listener of this.listeners) listener(this, at);
  }

  submit(body: QrSubmitOrderRequest): Promise<QrSubmitOrderResponse> {
    return this.call(
      'submit-order',
      'submit-order',
      { method: 'POST', body: JSON.stringify(body) },
      (answer) => QrSubmitOrderResponse.parse(answer),
    );
  }

  order(id: string): Promise<QrOrderView> {
    return this.call('order-status', `order-status?id=${id}`, { method: 'GET' }, (body) =>
      QrOrderView.parse(body),
    );
  }

  private async call<T>(
    operation: string,
    path: string,
    init: RequestInit,
    parse: (body: unknown) => T,
  ): Promise<T> {
    const started = performance.now();
    try {
      const response = await fetch(`${this.options.url}/${path}`, {
        ...init,
        headers: {
          [TABLE_TOKEN_HEADER]: this.options.token,
          [BROWSER_ID_HEADER]: this.browserId,
          ...(init.body !== undefined && { 'content-type': 'application/json' }),
        },
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const code = (body as { code?: unknown } | null)?.code;
        throw new RelayCallError(response.status, typeof code === 'string' ? code : '');
      }
      return parse(body);
    } catch (error) {
      countError(
        this.options.metrics,
        `relay ${operation} ${error instanceof RelayCallError ? `${String(error.status)} ${error.code}` : error instanceof Error ? error.name : 'Error'}`.trim(),
      );
      throw error;
    } finally {
      this.options.metrics.http.of(`relay ${operation}`).add(performance.now() - started);
    }
  }
}
