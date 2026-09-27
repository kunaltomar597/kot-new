import type {
  ApiClient,
  ConnectionStatus,
  DeviceKey,
  RealtimeConnection,
  RealtimeConnectionOptions,
  ResumePoint,
  TypedApi,
} from '@rp/api-client';
import type { DeviceSummary, DomainEvent, LoginResponse, StaffTile } from '@rp/contracts';
import { AlertCenter, type AlertNotifier } from './alert-center.js';
import { createMobileClient, CREDENTIALS_KEY, loadCredentials } from './client.js';
import { MenuCache } from './menu-cache.js';
import { OrderOutbox } from './order-outbox.js';
import { normalizeServerUrl } from './server-url.js';
import {
  findServer,
  type FoundServer,
  type PairingTarget,
  type ServerAuthority,
  ServerMismatchError,
  type ServerTrust,
  UnverifiedServerError,
} from './server-trust.js';
import { type KeyValueStore, readJson } from './storage.js';

/** Where the device key lives: the Android Keystore in the apps, a fake in tests. */
export interface DeviceKeyStore {
  load(): Promise<DeviceKey | undefined>;
  create(): Promise<DeviceKey>;
  remove(): Promise<void>;
}

/** A message for the next screen, e.g. why the person is back on the login screen. */
export type SessionNotice = 'signedOutInactive' | 'signedOut' | 'revoked';

export interface DeviceSessionSnapshot {
  /** `loading` while the stored device is checked; `unpaired` shows the pairing screen. */
  readonly phase: 'loading' | 'unpaired' | 'paired';
  readonly serverUrl: string | undefined;
  readonly device: DeviceSummary | undefined;
  readonly person: LoginResponse['staff'] | undefined;
  readonly session: LoginResponse['session'] | undefined;
  readonly connection: ConnectionStatus;
  readonly notice: SessionNotice | undefined;
}

export interface DeviceSessionOptions {
  /** The Keystore-backed store: device token and the person's tokens. */
  readonly secureStore: KeyValueStore;
  /** AsyncStorage: the server address and the live-update resume point (not secret). */
  readonly plainStore: KeyValueStore;
  readonly keys: DeviceKeyStore;
  /**
   * The LAN CA pinning of the device's HTTP clients (ADR-0011): the Android module in the apps.
   * Without it (tests, development tools) nothing is pinned.
   */
  readonly trust?: ServerTrust;
  /**
   * Follow the alerts of the person the phone alerts (P2-06a, WTR-006): the waiter app. Other
   * apps leave it off and never read alerts.
   */
  readonly followAlerts?: boolean;
  /** Where followed alerts go besides the screen: Android notifications (P2-06b). */
  readonly alertNotifier?: AlertNotifier;
  readonly appVersion?: string;
  readonly fetch?: typeof fetch;
  /** Socket.io's `io`; tests pass a fake. */
  readonly connect?: RealtimeConnectionOptions['connect'];
  /** Where background failures (saving to storage) are reported. */
  readonly onError?: (error: unknown) => void;
}

const SERVER_KEY = 'rp.server.v1';
const RESUME_KEY = 'rp.resume.v1';

const INITIAL: DeviceSessionSnapshot = {
  phase: 'loading',
  serverUrl: undefined,
  device: undefined,
  person: undefined,
  session: undefined,
  connection: 'stopped',
  notice: undefined,
};

/**
 * The phone's or tablet's link to the local server, outside React so it can be tested on its own
 * (AUTH-005, AUTH-007, AUTH-008): pairing with a Keystore key, signing staff in and out, the live
 * connection with resume, and what happens when the server ends the session or unpairs the device.
 * It also keeps the menu on the device current (MENU-013, MENU-006), sends unsent orders when
 * the connection comes back (WTR-012) and, on a waiter phone, follows the alerts of the person it
 * alerts (P2-06a). Screens read `getSnapshot()` through `useSyncExternalStore` and call the
 * actions.
 */
export class DeviceSession {
  /** The published menu on the device, fetched again on reconnect and when a new one is out. */
  readonly menu: MenuCache;
  /** Orders on their way to the kitchen; sent again on every reconnect. */
  readonly orders: OrderOutbox;
  /** The alerts of the person the phone alerts, when `followAlerts` is on (P2-06a). */
  readonly alerts: AlertCenter;
  private snapshot: DeviceSessionSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
  private client: ApiClient | undefined;
  private connection: RealtimeConnection | undefined;
  /** Bumped whenever the client is replaced, so late callbacks of an old client are ignored. */
  private generation = 0;

  constructor(private readonly options: DeviceSessionOptions) {
    this.menu = new MenuCache(options.plainStore);
    this.orders = new OrderOutbox({
      store: options.plainStore,
      api: () => this.api,
      staffId: () => this.snapshot.person?.id ?? null,
    });
    this.alerts = new AlertCenter({
      api: () => this.api,
      ...(options.alertNotifier !== undefined && { notifier: options.alertNotifier }),
      ...(options.onError !== undefined && { onError: options.onError }),
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): DeviceSessionSnapshot => this.snapshot;

  /** The typed REST API with this device's and person's credentials, for the screens. */
  get api(): TypedApi {
    if (this.client === undefined) throw new Error('The device is not paired');
    return this.client.api;
  }

  /** Loads the stored device and session and checks them with the server. */
  async start(): Promise<void> {
    const serverUrl = (await this.options.plainStore.getItem(SERVER_KEY)) ?? undefined;
    const key = await this.options.keys.load();
    const credentials = await loadCredentials(this.options.secureStore);
    if (serverUrl === undefined || key === undefined || credentials?.device === undefined) {
      this.update({ phase: 'unpaired' });
      return;
    }
    const generation = await this.replaceClient(serverUrl, key);
    const client = this.requireClient();
    let device: DeviceSummary | undefined;
    let person = client.session?.staff;
    let session = client.session?.session;
    try {
      device = await client.api.getCurrentDevice();
      if (client.session !== undefined) {
        const described = await client.api.getCurrentSession();
        person = described.staff;
        session = described.session;
      }
    } catch (error) {
      if (generation !== this.generation) return; // Unpaired while away: already handled.
      if (client.session === undefined) {
        person = undefined;
        session = undefined;
      }
      // Otherwise the server is unreachable: carry on with what was stored; the banner says so.
      this.options.onError?.(error);
    }
    if (generation !== this.generation) return;
    this.update({ phase: 'paired', serverUrl, device, person, session });
    this.connect(await this.loadResume());
  }

  /**
   * Finds the server to pair with among the addresses typed or scanned, checking a TLS server's CA
   * against the QR code's fingerprint (ADR-0011). Pass the result to `pair`.
   */
  findServer(target: PairingTarget): Promise<FoundServer> {
    return findServer(target, {
      ...(this.options.trust !== undefined && { trust: this.options.trust }),
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
    });
  }

  /**
   * Pairs with a manager's code (AUTH-007): a new Keystore key, then the server's device token.
   * Over TLS, the server's CA is pinned first (`authority`, from `findServer`), so the code only
   * ever travels to the server that CA vouches for (ADR-0011, SEC-010).
   */
  async pair(serverAddress: string, code: string, authority?: ServerAuthority): Promise<void> {
    const serverUrl = normalizeServerUrl(serverAddress);
    await this.trustServer(serverUrl, authority);
    const key = await this.options.keys.create();
    await this.options.secureStore.removeItem(CREDENTIALS_KEY);
    await this.replaceClient(serverUrl, key);
    const client = this.requireClient();
    await client.pair({
      code: code.trim().toUpperCase(),
      key,
      ...(this.options.appVersion !== undefined && { appVersion: this.options.appVersion }),
    });
    const device = await client.api.getCurrentDevice();
    await this.options.plainStore.setItem(SERVER_KEY, serverUrl);
    await this.options.plainStore.removeItem(RESUME_KEY);
    // Another restaurant's menu and alerts are no use here.
    await this.menu.clear();
    this.alerts.reset();
    this.update({
      phase: 'paired',
      serverUrl,
      device,
      person: undefined,
      session: undefined,
      notice: undefined,
    });
    this.connect(undefined);
  }

  async staffTiles(): Promise<StaffTile[]> {
    return (await this.api.listStaffTiles()).staff;
  }

  /** Signs a person in with their PIN (AUTH-001, AUTH-004). */
  async signIn(staffId: string, pin: string): Promise<void> {
    const login = await this.requireClient().signInWithPin({ staffId, pin });
    this.update({ person: login.staff, session: login.session, notice: undefined });
    // The person's role decides which rooms the connection joins.
    this.connect(undefined);
  }

  /**
   * Signs the person out on the server. On a waiter phone this also ends its alerts for them
   * (P2-06a); a sign-out for inactivity is the server's and keeps them, so never call this for it.
   */
  async signOut(notice?: SessionNotice): Promise<void> {
    await this.requireClient().signOut();
    this.update({ person: undefined, session: undefined, notice });
    this.connect(undefined);
  }

  /** Tells the server the person is still here (AUTH-005 inactivity). */
  async keepAlive(): Promise<void> {
    if (this.client?.session === undefined) return;
    try {
      await this.client.api.getCurrentSession();
    } catch {
      // A session that ended is reported through `onSessionEnded`; offline is shown by the banner.
    }
  }

  /** Domain events from the live connection, for screens that show live data. */
  onEvent(listener: (event: DomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== undefined) this.update({ notice: undefined });
  }

  stop(): void {
    this.connection?.stop();
    this.connection = undefined;
  }

  /** Pins the server's CA before anything is sent to it; nothing to pin without TLS. */
  private async trustServer(
    serverUrl: string,
    authority: ServerAuthority | undefined,
  ): Promise<void> {
    const trust = this.options.trust;
    if (trust === undefined || !serverUrl.startsWith('https:')) return;
    if (authority === undefined) throw new UnverifiedServerError();
    const pinned = await trust.pin(authority.certificate, serverUrl);
    if (pinned !== authority.sha256) {
      await trust.clear();
      throw new ServerMismatchError();
    }
  }

  private requireClient(): ApiClient {
    if (this.client === undefined) throw new Error('The device is not paired');
    return this.client;
  }

  private async replaceClient(serverUrl: string, key: DeviceKey): Promise<number> {
    this.stop();
    this.generation += 1;
    const generation = this.generation;
    this.client = await createMobileClient({
      baseUrl: serverUrl,
      secureStore: this.options.secureStore,
      signer: key,
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
      onSessionEnded: (code) => {
        if (generation === this.generation) this.sessionEnded(code);
      },
      onDeviceRevoked: () => {
        if (generation === this.generation) void this.forget();
      },
    });
    return generation;
  }

  private sessionEnded(code: string): void {
    if (this.snapshot.person === undefined) return;
    this.update({
      person: undefined,
      session: undefined,
      notice: code === 'SESSION_EXPIRED' ? 'signedOutInactive' : 'signedOut',
    });
    this.connect(undefined);
  }

  /** The server no longer knows this device: drop its key and credentials (AUTH-008). */
  private async forget(): Promise<void> {
    this.stop();
    this.generation += 1;
    this.client = undefined;
    this.update({
      phase: 'unpaired',
      device: undefined,
      person: undefined,
      session: undefined,
      connection: 'stopped',
      notice: 'revoked',
    });
    this.alerts.reset();
    try {
      await this.options.keys.remove();
      await this.options.plainStore.removeItem(RESUME_KEY);
      await this.options.trust?.clear();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private loadResume(): Promise<ResumePoint | undefined> {
    return readJson(this.options.plainStore, RESUME_KEY, (value) => {
      if (typeof value !== 'object' || value === null) throw new TypeError('Not a resume point');
      return value as ResumePoint;
    }).then((point) => point ?? undefined);
  }

  private saveResume(point: ResumePoint | undefined): void {
    const store = this.options.plainStore;
    (point === undefined
      ? store.removeItem(RESUME_KEY)
      : store.setItem(RESUME_KEY, JSON.stringify(point))
    ).catch((error: unknown) => this.options.onError?.(error));
  }

  private connect(resume: ResumePoint | undefined): void {
    this.connection?.stop();
    if (resume === undefined) this.saveResume(undefined);
    const connection = this.requireClient().connectRealtime({
      ...(resume !== undefined && { resume }),
      ...(this.options.connect !== undefined && { connect: this.options.connect }),
      onEvent: (event) => {
        this.keepMenuCurrent(event);
        if (this.options.followAlerts === true) this.alerts.handleEvent(event);
        for (const listener of this.eventListeners) listener(event);
      },
      onStatus: (status) => {
        if (this.connection !== connection) return;
        const cameOnline = status === 'online' && this.snapshot.connection !== 'online';
        this.update({ connection: status });
        if (cameOnline) {
          this.refreshMenu({ force: true });
          this.orders.flush().catch((error: unknown) => this.options.onError?.(error));
          // Alerts missed while away are read again (NTF-006); so is a change of holder.
          if (this.options.followAlerts === true) void this.alerts.refresh();
        }
      },
      onResumePoint: (point) => {
        this.saveResume(point);
      },
    });
    this.connection = connection;
    connection.start();
  }

  /** A newer menu is fetched; availability changes apply to the stored one (MENU-006). */
  private keepMenuCurrent(event: DomainEvent): void {
    if (event.type === 'MenuPublished') {
      this.refreshMenu({ announcedVersion: event.payload.menuVersion });
    } else if (event.type === 'ItemAvailabilityChanged') {
      this.menu
        .applyAvailability(event.payload)
        .catch((error: unknown) => this.options.onError?.(error));
    }
  }

  private refreshMenu(options: { announcedVersion?: number; force?: boolean }): void {
    const client = this.client;
    if (client === undefined) return;
    this.menu
      .refresh(() => client.api.getMenu(), options)
      .catch((error: unknown) => this.options.onError?.(error));
  }

  private update(changes: Partial<DeviceSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
