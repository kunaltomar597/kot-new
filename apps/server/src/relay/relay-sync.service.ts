import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { DomainEvent } from '@rp/contracts';
import type {
  QrMenuDocument,
  QrRelaySettings,
  RelayTable,
  SyncRelayTablesResponse,
} from '@rp/contracts/relay';
import { canonicalJson } from '@rp/domain';
import { qrChannelMenu } from '@rp/ordering';
import { z } from 'zod';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { EventBus } from '../events/event-bus.js';
import { tableTokenHash } from '../floor/table-qr.service.js';
import { MenuPublishService } from '../menu/menu-publish.service.js';
import { SettingsService, type SettingsSnapshot } from '../settings/settings.service.js';
import { PacedLoop } from './paced-loop.js';
import { RelayClient, RelayError } from './relay-client.js';
import { readRelayCredential } from './relay-credential.js';

export const RELAY_SYNC_OPTIONS = Symbol('RELAY_SYNC_OPTIONS');

export interface RelaySyncOptions {
  /** Wait after start-up before the first sync (let the server settle). */
  readonly firstDelayMs: number;
  /** After a change that the QR menu shows, sync this soon (MENU-006: within 30 s). */
  readonly debounceMs: number;
  /** After a failure: this, doubling per failure, up to `retryMaxMs`. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly requestTimeoutMs: number;
  /** Replaces `fetch` (tests). */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_RELAY_SYNC_OPTIONS: RelaySyncOptions = {
  firstDelayMs: 10_000,
  debounceMs: 2_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  requestTimeoutMs: 15_000,
};

/** What the server knows about its link to the QR relay (System page). */
export interface RelaySyncStatus {
  /** A relay address is set. */
  readonly configured: boolean;
  /** A credential is stored. */
  readonly credential: boolean;
  readonly lastSuccessAt: Date | null;
  /** `UNREACHABLE`, `NO_CREDENTIAL`, the relay's error code, or null when fine. */
  readonly lastError: string | null;
  /** The menu version the relay serves, or null before the first publication. */
  readonly menuVersion: number | null;
  /** The relay's clock minus this PC's, from the last presence (QR-007 deadlines use it). */
  readonly clockOffsetMs: number | null;
}

/** What has reached the relay, kept across restarts so nothing is resent or missed. */
const SyncState = z.object({
  menuVersion: z.int().nonnegative(),
  menuHash: z.string().nullable(),
  tablesHash: z.string().nullable(),
});
type SyncState = z.infer<typeof SyncState>;
const STATE_KEY = 'relay.sync';

const hashOf = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** QR settings the relay enforces (`qr.*`, QR-006 to QR-008). */
export function relaySettingsOf(settings: SettingsSnapshot): QrRelaySettings {
  return {
    submissionsPerWindow: settings.get('qr.submissionsPerWindow'),
    rateLimitWindowMinutes: settings.get('qr.rateLimitWindowMinutes'),
    pickupTimeoutSeconds: settings.get('qr.pickupTimeoutSeconds'),
    presenceIntervalSeconds: settings.get('qr.presenceIntervalSeconds'),
    readOnlyAfterSeconds: settings.get('qr.readOnlyAfterSeconds'),
  };
}

/** Does this event change what the QR page shows or the relay enforces? */
export function concernsRelay(event: DomainEvent): boolean {
  switch (event.type) {
    case 'MenuPublished':
    case 'ItemAvailabilityChanged':
      return true;
    case 'SettingsChanged':
      return event.payload.keys.some(
        (key) => key.startsWith('qr.') || key === 'orders.specialInstructionsMaxLength',
      );
    case 'RestaurantChanged':
      return event.payload.part === 'PROFILE' || event.payload.part === 'FLOOR';
    default:
      return false;
  }
}

/**
 * The QR relay's sync agent, publishing side (P5-03a, QR-003, QR-008, ADR-0015). One loop keeps
 * the relay in step with this restaurant:
 * - presence every `qr.presenceIntervalSeconds`, with the QR settings;
 * - the tables and their QR code hashes, when they change;
 * - the QR menu (with live availability) as a new version, when it changes.
 * What reached the relay is remembered by its hash, so a change made while offline is sent once
 * the relay answers again and nothing is ever dropped (NFR-A01). Menu, stock, settings and floor
 * events bring the next sync forward, so the QR page follows within seconds (MENU-006).
 */
@Injectable()
export class RelaySyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RelaySyncService.name);
  private readonly loop: PacedLoop;
  private unsubscribe: (() => void) | undefined;
  private state: Omit<RelaySyncStatus, 'configured'> = {
    credential: false,
    lastSuccessAt: null,
    lastError: null,
    menuVersion: null,
    clockOffsetMs: null,
  };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly menus: MenuPublishService,
    private readonly events: EventBus,
    @Inject(RELAY_SYNC_OPTIONS) private readonly options: RelaySyncOptions,
  ) {
    this.loop = new PacedLoop(
      () => this.cycle(),
      options,
      (error) => {
        const code = error instanceof RelayError ? error.code : 'INTERNAL';
        this.fail(code, error instanceof Error ? error.message : String(error), error);
      },
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.relayUrl === undefined) return;
    this.unsubscribe = this.events.onPublished((events) => {
      if (events.some(({ event }) => concernsRelay(event))) this.loop.soon(this.options.debounceMs);
    });
    this.loop.start(this.options.firstDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    await this.loop.stop();
  }

  status(): RelaySyncStatus {
    return { configured: this.config.relayUrl !== undefined, ...this.state };
  }

  /**
   * Syncs now (the loop calls it; so do tests and support tools) and answers with the state after
   * it; a call during a sync waits for one more, so whatever changed before the call is in it.
   */
  async sync(): Promise<RelaySyncStatus> {
    await this.loop.run();
    return this.status();
  }

  /** The relay credential and address, or undefined (with the reason noted) when not set up. */
  async client(): Promise<RelayClient | undefined> {
    const baseUrl = this.config.relayUrl;
    if (baseUrl === undefined) return undefined;
    const credential = await readRelayCredential(this.prisma, this.secrets);
    this.state = { ...this.state, credential: credential !== undefined };
    if (credential === undefined) {
      this.fail('NO_CREDENTIAL', 'No relay credential is stored (pnpm relay:credential)');
      return undefined;
    }
    return new RelayClient({
      baseUrl,
      credential,
      timeoutMs: this.options.requestTimeoutMs,
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
    });
  }

  /** One sync; resolves with the delay until the next (the presence interval). */
  private async cycle(): Promise<number> {
    const client = await this.client();
    if (client === undefined) return this.options.retryMaxMs;
    const restaurant = await this.prisma.restaurant.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, displayName: true, accentColor: true, timeZone: true },
    });
    if (restaurant === null) {
      this.fail('NOT_SET_UP', 'The restaurant is not set up yet');
      return this.options.retryMaxMs;
    }
    const settings = await this.settings.snapshot(restaurant.id);
    const sentAt = Date.now();
    const presence = await client.presence({
      serverVersion: SERVER_PACKAGE.version,
      settings: relaySettingsOf(settings),
    });
    const clockOffsetMs = Date.parse(presence.serverTime) - (sentAt + Date.now()) / 2;

    let saved = await this.readState();
    saved = await this.syncTables(client, restaurant.id, saved);
    saved = await this.syncMenu(client, restaurant, settings, saved);

    if (this.state.lastError !== null) this.logger.log('In step with the QR relay again');
    this.state = {
      ...this.state,
      lastSuccessAt: new Date(),
      lastError: null,
      menuVersion: saved.menuVersion === 0 ? null : saved.menuVersion,
      clockOffsetMs: Math.round(clockOffsetMs),
    };
    return settings.get('qr.presenceIntervalSeconds') * 1_000;
  }

  /** QR-001: every table, with its QR code's hash once it has one (P5-04). */
  private async syncTables(
    client: RelayClient,
    restaurantId: string,
    saved: SyncState,
  ): Promise<SyncState> {
    const rows = await this.prisma.diningTable.findMany({
      where: { restaurantId },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
      select: { id: true, label: true, archivedAt: true, qrToken: true },
    });
    const tables: RelayTable[] = rows.map((row) => ({
      tableId: row.id,
      label: row.label.slice(0, 40),
      // Only the hash leaves this PC (QR-001, ADR-0015).
      tokenHash: row.qrToken === null ? null : tableTokenHash(row.qrToken),
      active: row.archivedAt === null,
    }));
    const hash = hashOf(tables);
    if (hash === saved.tablesHash) return saved;
    const answer: SyncRelayTablesResponse = await client.syncTables({ tables });
    this.logger.debug({ ...answer }, 'Tables sent to the QR relay');
    const next = { ...saved, tablesHash: hash };
    await this.writeState(next);
    return next;
  }

  /** QR-003: the QR menu as a new version when anything the page shows has changed. */
  private async syncMenu(
    client: RelayClient,
    restaurant: { id: string; displayName: string; accentColor: string | null; timeZone: string },
    settings: SettingsSnapshot,
    saved: SyncState,
  ): Promise<SyncState> {
    let menu;
    try {
      menu = await this.menus.current(restaurant.id);
    } catch (error) {
      // Nothing to show before the first publication.
      if (error instanceof AppError && error.code === 'MENU_NOT_PUBLISHED') return saved;
      throw error;
    }
    const document: QrMenuDocument = {
      restaurantName: restaurant.displayName.slice(0, 120),
      ...(restaurant.accentColor !== null && { accentColor: restaurant.accentColor }),
      timeZone: restaurant.timeZone,
      instructionMaxLength: settings.get('orders.specialInstructionsMaxLength'),
      priceMode: settings.get('billing.priceMode'),
      // QR-011 (S) comes with the QR site's service requests (P5-05).
      serviceRequests: false,
      menu: qrChannelMenu(menu),
      // Photos are mirrored to the relay's Storage in P5-03c.
      photos: [],
    };
    const hash = hashOf(document);
    if (hash === saved.menuHash) return saved;
    let version = saved.menuVersion + 1;
    try {
      await client.publishMenu({ version, document });
    } catch (error) {
      // The relay has a newer version than this PC remembers (a restored backup, a lost write):
      // publish after it.
      const latest = error instanceof RelayError ? error.details.latest : undefined;
      if (
        !(error instanceof RelayError) ||
        error.code !== 'STALE_MENU_VERSION' ||
        typeof latest !== 'number'
      ) {
        throw error;
      }
      version = latest + 1;
      await client.publishMenu({ version, document });
    }
    this.logger.log({ version }, 'QR menu published to the relay');
    const next = { ...saved, menuVersion: version, menuHash: hash };
    await this.writeState(next);
    return next;
  }

  private async readState(): Promise<SyncState> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: STATE_KEY } });
    const parsed = row === null ? undefined : SyncState.safeParse(JSON.parse(row.value));
    return parsed?.success === true
      ? parsed.data
      : { menuVersion: 0, menuHash: null, tablesHash: null };
  }

  private async writeState(state: SyncState): Promise<void> {
    const value = JSON.stringify(state);
    await this.prisma.systemMeta.upsert({
      where: { key: STATE_KEY },
      create: { key: STATE_KEY, value },
      update: { value },
    });
  }

  /** Logs only when the failure changes, so an offline restaurant does not flood the log. */
  private fail(code: string, message: string, error?: unknown): void {
    if (this.state.lastError !== code) {
      this.logger.warn({ code, err: error }, `QR relay not in step: ${message}`);
    }
    this.state = { ...this.state, lastError: code };
  }
}
