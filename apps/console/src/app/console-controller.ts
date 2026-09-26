import {
  ApiClient,
  ApiRequestError,
  type ConnectionStatus,
  type DeviceKey,
  generateWebCryptoDeviceKey,
  type RealtimeConnection,
  type RealtimeConnectionOptions,
  type ResumePoint,
  type StoredCredentials,
  type TypedApi,
  webCryptoDeviceKey,
} from '@rp/api-client';
import type { DeviceSummary, DomainEvent, LoginResponse, StaffTile } from '@rp/contracts';
import type { ConsoleStorage } from './storage.js';

/** A message for the next screen, e.g. why the person is back on the login screen. */
export type Notice = 'signedOutInactive' | 'signedOut' | 'revoked';

export interface ConsoleSnapshot {
  /** `loading` while the stored device is checked; `unpaired` shows the pairing screen. */
  readonly phase: 'loading' | 'unpaired' | 'paired';
  readonly device: DeviceSummary | undefined;
  readonly person: LoginResponse['staff'] | undefined;
  readonly session: LoginResponse['session'] | undefined;
  /** For the connection banner. */
  readonly connection: ConnectionStatus;
  readonly notice: Notice | undefined;
}

export interface ConsoleControllerOptions {
  /** The local server; empty for the page's own origin (the server serves the console). */
  readonly baseUrl: string;
  readonly storage: ConsoleStorage;
  readonly fetch?: typeof fetch;
  /** Socket.io's `io`; tests pass a fake. */
  readonly connect?: RealtimeConnectionOptions['connect'];
  readonly generateKey?: () => Promise<{ keyPair: CryptoKeyPair; key: DeviceKey }>;
  readonly keyFromPair?: (keyPair: CryptoKeyPair) => Promise<DeviceKey>;
  readonly appVersion?: string;
  /** Where background failures (saving to storage) are reported. */
  readonly onError?: (error: unknown) => void;
}

const INITIAL: ConsoleSnapshot = {
  phase: 'loading',
  device: undefined,
  person: undefined,
  session: undefined,
  connection: 'stopped',
  notice: undefined,
};

/**
 * The console's state and actions, outside React so they can be tested on their own: pairing,
 * signing in and out, the live connection, and what happens when the server ends the session or
 * unpairs the device (AUTH-005, AUTH-007, AUTH-008, NFR-P11). Screens read `getSnapshot()` through
 * `useSyncExternalStore` and call the actions.
 */
export class ConsoleController {
  private snapshot: ConsoleSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
  private client: ApiClient;
  private connection: RealtimeConnection | undefined;

  constructor(private readonly options: ConsoleControllerOptions) {
    this.client = this.createClient(undefined, undefined, undefined);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ConsoleSnapshot => this.snapshot;

  /** The typed REST API with this device's and person's credentials, for the screens. */
  get api(): TypedApi {
    return this.client.api;
  }

  /** Loads the stored device and session and checks them with the server. */
  async start(): Promise<void> {
    const record = await this.options.storage.loadDevice();
    if (record === undefined) {
      this.update({ phase: 'unpaired' });
      return;
    }
    const session = this.options.storage.loadSession();
    this.client = this.createClient(
      { device: record.device, ...(session !== undefined && { session }) },
      await this.keyFromPair(record.keyPair),
      record.keyPair,
    );
    let device = record.summary;
    let person = session?.staff;
    let current = session?.session;
    try {
      device = await this.client.api.getCurrentDevice();
      await this.options.storage.saveDevice({ ...record, summary: device });
      if (this.client.session !== undefined) {
        const described = await this.client.api.getCurrentSession();
        person = described.staff;
        current = described.session;
      }
    } catch (error) {
      if (this.client.device === undefined) return; // Unpaired while away: already handled.
      if (error instanceof ApiRequestError && this.client.session === undefined) {
        person = undefined;
        current = undefined;
      }
      // Otherwise the server is unreachable: carry on with what was stored; the banner says so.
    }
    this.update({ phase: 'paired', device, person, session: current });
    this.connect(this.options.storage.loadResume());
  }

  /** Pairs this browser with a manager's code, creating its device key (AUTH-007). */
  async pair(code: string): Promise<void> {
    const { keyPair, key } = await (this.options.generateKey ?? generateWebCryptoDeviceKey)();
    const client = this.createClient(undefined, key, keyPair);
    await client.pair({
      code,
      key,
      ...(this.options.appVersion !== undefined && { appVersion: this.options.appVersion }),
    });
    const summary = await client.api.getCurrentDevice();
    const device = client.device;
    if (device === undefined) throw new Error('Pairing did not return a device');
    await this.options.storage.saveDevice({ keyPair, device, summary });
    this.options.storage.saveSession(undefined);
    this.options.storage.saveResume(undefined);
    this.client = client;
    this.update({
      phase: 'paired',
      device: summary,
      person: undefined,
      session: undefined,
      notice: undefined,
    });
    this.connect(undefined);
  }

  async staffTiles(): Promise<StaffTile[]> {
    return (await this.client.api.listStaffTiles()).staff;
  }

  /** Signs a person in with their PIN (AUTH-001, AUTH-004). */
  async signIn(staffId: string, pin: string): Promise<void> {
    const login = await this.client.signInWithPin({ staffId, pin });
    this.update({ person: login.staff, session: login.session, notice: undefined });
    // The person's role decides which rooms the connection joins.
    this.connect(undefined);
  }

  async signOut(notice?: Notice): Promise<void> {
    await this.client.signOut();
    this.update({ person: undefined, session: undefined, notice });
    this.connect(undefined);
  }

  /** Tells the server the person is still here (AUTH-005 inactivity). */
  async keepAlive(): Promise<void> {
    if (this.client.session === undefined) return;
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

  /** Clears the notice once it has been shown. */
  dismissNotice(): void {
    if (this.snapshot.notice !== undefined) this.update({ notice: undefined });
  }

  stop(): void {
    this.connection?.stop();
    this.connection = undefined;
  }

  private createClient(
    credentials: StoredCredentials | undefined,
    key: DeviceKey | undefined,
    keyPair: CryptoKeyPair | undefined,
  ): ApiClient {
    return new ApiClient({
      baseUrl: this.options.baseUrl,
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
      ...(credentials !== undefined && { credentials }),
      ...(key !== undefined && { signer: key }),
      onCredentialsChange: (changed) => {
        this.persist(changed, keyPair);
      },
      onSessionEnded: (code) => {
        this.sessionEnded(code);
      },
      onDeviceRevoked: () => {
        void this.forget();
      },
    });
  }

  private persist(credentials: StoredCredentials, keyPair: CryptoKeyPair | undefined): void {
    this.options.storage.saveSession(credentials.session);
    const summary = this.snapshot.device;
    if (credentials.device === undefined || keyPair === undefined || summary === undefined) return;
    this.options.storage
      .saveDevice({ keyPair, device: credentials.device, summary })
      .catch((error: unknown) => this.options.onError?.(error));
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

  private async forget(): Promise<void> {
    this.stop();
    this.client = this.createClient(undefined, undefined, undefined);
    this.options.storage.saveSession(undefined);
    this.options.storage.saveResume(undefined);
    this.update({
      phase: 'unpaired',
      device: undefined,
      person: undefined,
      session: undefined,
      connection: 'stopped',
      notice: 'revoked',
    });
    await this.options.storage.saveDevice(undefined);
  }

  private connect(resume: ResumePoint | undefined): void {
    this.connection?.stop();
    if (resume === undefined) this.options.storage.saveResume(undefined);
    const connection = this.client.connectRealtime({
      ...(resume !== undefined && { resume }),
      ...(this.options.connect !== undefined && { connect: this.options.connect }),
      onEvent: (event) => {
        for (const listener of this.eventListeners) listener(event);
      },
      onStatus: (status) => {
        if (this.connection === connection) this.update({ connection: status });
      },
      onResumePoint: (point) => {
        this.options.storage.saveResume(point);
      },
    });
    this.connection = connection;
    connection.start();
  }

  private async keyFromPair(keyPair: CryptoKeyPair): Promise<DeviceKey> {
    return (this.options.keyFromPair ?? webCryptoDeviceKey)(keyPair);
  }

  private update(changes: Partial<ConsoleSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
