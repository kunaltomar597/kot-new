import {
  DEVICE_TOKEN_HEADER,
  deviceTokenMessage,
  type LoginResponse,
  OVERRIDE_TOKEN_HEADER,
  type OwnerLoginRequest,
  type PairedDevice,
  pairingProofMessage,
  type PinLoginRequest,
  type RealtimeEndReason,
  type RouteDefinition,
} from '@rp/contracts';
import type { z } from 'zod';
import type { DeviceKey, DeviceSigner } from './device-key.js';
import {
  ApiContractError,
  ApiRequestError,
  ApiUnavailableError,
  errorFromResponse,
} from './errors.js';
import { newCorrelationId } from './ids.js';
import {
  RealtimeConnection,
  type RealtimeAuthority,
  type RealtimeConnectionOptions,
  type RecoveryDecision,
} from './realtime.js';
import {
  accessOf,
  type CallOptions,
  OPERATION_IDS,
  type OperationId,
  type RequestArgs,
  type ResponseOf,
  type RouteAccess,
  routeFor,
  type TypedApi,
} from './routes.js';

export const CORRELATION_HEADER = 'x-correlation-id';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Renew an access token this long before it expires. */
const ACCESS_TOKEN_MARGIN_MS = 30_000;
/** Renew a device token this long before it expires. */
const DEVICE_TOKEN_MARGIN_MS = 60_000;
/** Server answers that mean the person's session is over (AUTH-005). */
const SESSION_OVER = new Set([
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'TOKEN_INVALID',
  'DEVICE_MISMATCH',
]);

/** The device's identity and current device token (AUTH-007). */
export interface StoredDevice {
  readonly deviceId: string;
  readonly deviceToken?: string;
  readonly deviceTokenExpiresAt?: string;
}

/**
 * Everything the client needs to act for this device and the person signed in on it. Keep it in
 * the platform's secure storage (it holds the refresh token) and pass it back after a restart.
 */
export interface StoredCredentials {
  readonly device?: StoredDevice;
  readonly session?: LoginResponse;
}

export interface ApiClientOptions {
  /** The local server, e.g. `https://pos.local:8443`; empty for the page's own origin. */
  readonly baseUrl: string;
  /** Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly credentials?: StoredCredentials;
  /** The device key: needed to get new device tokens (they last an hour). */
  readonly signer?: DeviceSigner;
  /** Called whenever the credentials change (tokens rotate on every refresh): persist them. */
  readonly onCredentialsChange?: (credentials: StoredCredentials) => void;
  /** The person's session ended without a sign-out here: inactivity, expiry, revoked elsewhere. */
  readonly onSessionEnded?: (code: string) => void;
  /** The device was unpaired (or its key is no longer accepted): show the pairing screen. */
  readonly onDeviceRevoked?: () => void;
  readonly timeoutMs?: number;
}

type AnyInput = CallOptions & {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
};

interface Prepared {
  readonly route: RouteDefinition;
  readonly url: string;
  readonly body: string | undefined;
}

/**
 * The typed REST client of the local server (P0-14). Every call is checked against the contract
 * before it is sent and its answer after it arrives. The client:
 *
 * - sends the device token on every call, renewing it with the device key before it expires;
 * - sends the signed-in person's access token, refreshing it (single flight) before it expires or
 *   when the server says it has, and retrying the call once;
 * - reports a session that ended (`onSessionEnded`) or a device that was unpaired
 *   (`onDeviceRevoked`);
 * - maps failures to `ApiRequestError` (the server said no), `ApiUnavailableError` (offline,
 *   timeout) or `ApiContractError` (a bug or a version mismatch).
 */
export class ApiClient implements RealtimeAuthority {
  /** One method per REST operation, e.g. `client.api.listStaffTiles()`. */
  readonly api: TypedApi;
  private stored: StoredCredentials;
  private signer: DeviceSigner | undefined;
  private refreshing: Promise<boolean> | undefined;
  private renewing: Promise<string> | undefined;
  /** Server clock minus device clock, from the `Date` header, so expiry checks survive skew. */
  private clockSkewMs = 0;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.stored = options.credentials ?? {};
    this.signer = options.signer;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = withoutTrailingSlashes(options.baseUrl);
    const api: Record<string, (input?: AnyInput) => Promise<unknown>> = {};
    for (const operationId of OPERATION_IDS) {
      api[operationId] = (input?: AnyInput) => this.call(operationId, input ?? {});
    }
    this.api = api as unknown as TypedApi;
  }

  get credentials(): StoredCredentials {
    return this.stored;
  }

  get device(): StoredDevice | undefined {
    return this.stored.device;
  }

  get session(): LoginResponse | undefined {
    return this.stored.session;
  }

  /** Sets the device key after a restart (it is not part of the stored credentials). */
  setSigner(signer: DeviceSigner | undefined): void {
    this.signer = signer;
  }

  /** Calls a REST operation by its contract name. */
  request<Op extends OperationId>(
    operationId: Op,
    ...args: RequestArgs<Op>
  ): Promise<ResponseOf<Op>> {
    return this.call(operationId, args[0] ?? {}) as Promise<ResponseOf<Op>>;
  }

  /**
   * Pairs this device with a manager's one-time code (AUTH-007): proves possession of the key,
   * stores the device identity and gets the first device token.
   */
  async pair(input: {
    readonly code: string;
    readonly key: DeviceKey;
    readonly appVersion?: string;
  }): Promise<PairedDevice> {
    const proof = await input.key.sign(pairingProofMessage(input.code));
    const paired = await this.request('pairDevice', {
      body: {
        code: input.code,
        algorithm: input.key.algorithm,
        publicKey: input.key.publicKey,
        proof,
        ...(input.appVersion !== undefined && { appVersion: input.appVersion }),
      },
    });
    this.signer = input.key;
    this.update({ device: { deviceId: paired.deviceId } });
    await this.deviceToken(true);
    return paired;
  }

  /** Signs a person in with their PIN on this device (AUTH-001, AUTH-004). */
  async signInWithPin(body: PinLoginRequest): Promise<LoginResponse> {
    const session = await this.request('pinLogin', { body });
    this.update({ ...this.stored, session });
    return session;
  }

  /** Signs the Owner in with password and second factor (AUTH-006). */
  async signInAsOwner(body: OwnerLoginRequest): Promise<LoginResponse> {
    const session = await this.request('ownerLogin', { body });
    this.update({ ...this.stored, session });
    return session;
  }

  /**
   * Signs the person out. The local session is always cleared, even when the server cannot be
   * reached (it then ends by inactivity there).
   */
  async signOut(): Promise<void> {
    if (this.stored.session === undefined) return;
    try {
      await this.request('logout');
    } catch {
      // Signing out here must always work; the server ends an unused session by itself.
    } finally {
      this.update({ ...this.stored, session: undefined });
    }
  }

  /** Forgets the device and any session (after unpairing, or to pair it again). */
  forgetDevice(): void {
    this.signer = undefined;
    this.update({});
  }

  /** A valid device token, renewed with the device key when it is about to expire. */
  async deviceToken(force = false): Promise<string> {
    const device = this.stored.device;
    if (device === undefined) {
      throw new ApiRequestError(401, {
        code: 'DEVICE_NOT_PAIRED',
        message: 'This device is not paired. Ask a manager for a pairing code.',
      });
    }
    const current = device.deviceToken;
    const fresh =
      current !== undefined &&
      !this.expiresWithin(device.deviceTokenExpiresAt, DEVICE_TOKEN_MARGIN_MS);
    if (!force && fresh) return current;
    if (this.signer === undefined) {
      // Without the key the current token is all there is; the server decides.
      if (current !== undefined && !force) return current;
      throw new ApiRequestError(401, {
        code: 'DEVICE_KEY_MISSING',
        message: 'This device’s key is missing. Pair the device again.',
      });
    }
    this.renewing ??= this.renewDeviceToken(device.deviceId, this.signer).finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  /**
   * A valid access token for the signed-in person, refreshed when it is about to expire;
   * undefined when nobody is signed in (or the session just ended).
   */
  async accessToken(force = false): Promise<string | undefined> {
    const session = this.stored.session;
    if (session === undefined) return undefined;
    if (!force && !this.expiresWithin(session.accessTokenExpiresAt, ACCESS_TOKEN_MARGIN_MS)) {
      return session.accessToken;
    }
    return (await this.refreshSession()) ? this.stored.session?.accessToken : undefined;
  }

  /** Opens the live connection with this client's credentials (P0-12 protocol). */
  connectRealtime(
    options: Omit<RealtimeConnectionOptions, 'url'> & { readonly url?: string },
  ): RealtimeConnection {
    return new RealtimeConnection(this, { ...options, url: options.url ?? this.baseUrl });
  }

  // RealtimeAuthority: the socket shares this client's credentials and recovery.

  async handshake(): Promise<{ deviceToken: string; accessToken?: string }> {
    const deviceToken = await this.deviceToken();
    let accessToken: string | undefined;
    try {
      accessToken = await this.accessToken();
    } catch (error) {
      if (!(error instanceof ApiUnavailableError)) throw error;
      accessToken = this.stored.session?.accessToken;
    }
    return { deviceToken, ...(accessToken !== undefined && { accessToken }) };
  }

  async recover(code: string): Promise<RecoveryDecision> {
    try {
      if (code === 'TOKEN_EXPIRED') {
        // Refreshed, or the session ended and the device reconnects on its own.
        await this.refreshSession();
        return 'retry';
      }
      if (SESSION_OVER.has(code)) {
        this.endSession(code);
        return 'retry';
      }
      if (code === 'DEVICE_NOT_RECOGNISED') {
        await this.deviceToken(true);
        return 'retry';
      }
      return 'stop';
    } catch (error) {
      if (error instanceof ApiUnavailableError) return 'retry';
      // A device that can no longer get a token has been forgotten by now.
      return this.stored.device === undefined ? 'stop' : 'retry';
    }
  }

  ended(reason: RealtimeEndReason): void {
    if (reason === 'SESSION_ENDED') this.endSession(reason);
    else if (reason === 'DEVICE_REVOKED') this.deviceRevoked();
  }

  // Internals.

  private async call(operationId: OperationId, input: AnyInput): Promise<unknown> {
    const prepared = this.prepare(routeFor(operationId), input);
    const access = accessOf(prepared.route);
    let retried = false;
    for (;;) {
      const correlationId = input.correlationId ?? newCorrelationId();
      const response = await this.send(
        prepared,
        await this.headers(access, input, correlationId),
        input,
      );
      this.observeClock(response);
      const body = await readJson(response);
      if (response.ok) return this.success(prepared.route, response.status, body, correlationId);
      const error = errorFromResponse(response.status, body, correlationId);
      if (response.status === 401 && !retried && access !== 'public') {
        if (
          error.code === 'TOKEN_EXPIRED' &&
          access === 'session' &&
          (await this.refreshSession())
        ) {
          retried = true;
          continue;
        }
        if (error.code === 'DEVICE_NOT_RECOGNISED' && this.signer !== undefined) {
          await this.deviceToken(true);
          retried = true;
          continue;
        }
      }
      if (response.status === 401 && access === 'session' && SESSION_OVER.has(error.code)) {
        this.endSession(error.code);
      }
      throw error;
    }
  }

  private prepare(route: RouteDefinition, input: AnyInput): Prepared {
    let path = route.path;
    const { params, query, body } = route.request ?? {};
    if (params !== undefined) {
      const values = this.check(params, input.params, route, 'path parameters') as Record<
        string,
        unknown
      >;
      path = path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
        encodeURIComponent(String(values[name])),
      );
    }
    let search = '';
    if (query !== undefined && input.query !== undefined) {
      const values = this.check(query, input.query, route, 'query') as Record<string, unknown>;
      const parameters = new URLSearchParams();
      for (const [name, value] of Object.entries(values)) {
        for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            parameters.append(name, String(item));
          }
        }
      }
      const text = parameters.toString();
      search = text === '' ? '' : `?${text}`;
    }
    return {
      route,
      url: `${this.baseUrl}${path}${search}`,
      body:
        body === undefined
          ? undefined
          : JSON.stringify(this.check(body, input.body, route, 'body')),
    };
  }

  private check(schema: z.ZodType, value: unknown, route: RouteDefinition, what: string): unknown {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || what}: ${issue.message}`)
        .join('; ');
      throw new ApiContractError(`The ${what} of ${route.operationId} are invalid: ${problems}`);
    }
    return parsed.data;
  }

  private async headers(
    access: RouteAccess,
    input: CallOptions,
    correlationId: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      [CORRELATION_HEADER]: correlationId,
    };
    if (access !== 'public') headers[DEVICE_TOKEN_HEADER] = await this.deviceToken();
    if (access === 'session') {
      const accessToken = await this.accessToken();
      if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`;
    }
    if (input.overrideToken !== undefined) headers[OVERRIDE_TOKEN_HEADER] = input.overrideToken;
    return headers;
  }

  private async send(
    prepared: Prepared,
    headers: Record<string, string>,
    input: CallOptions,
  ): Promise<Response> {
    const { signal } = input;
    if (aborted(signal)) throw signal?.reason;
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      input.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      return await this.fetcher(prepared.url, {
        method: prepared.route.method,
        headers:
          prepared.body === undefined
            ? headers
            : { ...headers, 'content-type': 'application/json' },
        ...(prepared.body !== undefined && { body: prepared.body }),
        signal: controller.signal,
      });
    } catch (error) {
      // The caller cancelled: pass their reason on (checked again: it may have changed meanwhile).
      if (aborted(signal)) throw signal?.reason;
      // Not the caller: our own timer aborted it.
      throw new ApiUnavailableError(controller.signal.aborted ? 'timeout' : 'network', error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private success(
    route: RouteDefinition,
    status: number,
    body: unknown,
    correlationId: string,
  ): unknown {
    const schema = route.responses[status]?.schema;
    if (schema === undefined) return undefined;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiContractError(
        `The answer to ${route.operationId} does not match the contract`,
        correlationId,
        parsed.error,
      );
    }
    return parsed.data;
  }

  private observeClock(response: Response): void {
    const date = response.headers.get('date');
    const server = date === null ? Number.NaN : Date.parse(date);
    if (!Number.isNaN(server)) this.clockSkewMs = server - Date.now();
  }

  private expiresWithin(expiresAt: string | undefined, marginMs: number): boolean {
    if (expiresAt === undefined) return true;
    return Date.parse(expiresAt) - this.clockSkewMs - Date.now() < marginMs;
  }

  private async renewDeviceToken(deviceId: string, signer: DeviceSigner): Promise<string> {
    const { challenge } = await this.request('createDeviceChallenge', { body: { deviceId } });
    const signature = await signer.sign(deviceTokenMessage(deviceId, challenge));
    try {
      const issued = await this.request('issueDeviceToken', {
        body: { deviceId, challenge, signature },
      });
      if (this.stored.device?.deviceId === deviceId) {
        this.update({
          ...this.stored,
          device: {
            deviceId,
            deviceToken: issued.deviceToken,
            deviceTokenExpiresAt: issued.expiresAt,
          },
        });
      }
      return issued.deviceToken;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) this.deviceRevoked();
      throw error;
    }
  }

  /** Renews the session's tokens; false when the session is over (it has then been cleared). */
  private refreshSession(): Promise<boolean> {
    this.refreshing ??= this.renewSession().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async renewSession(): Promise<boolean> {
    const session = this.stored.session;
    if (session === undefined) return false;
    try {
      const renewed = await this.request('refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      // Someone signed out or in meanwhile: keep what is there now.
      if (this.stored.session?.refreshToken !== session.refreshToken) {
        return this.stored.session !== undefined;
      }
      this.update({ ...this.stored, session: renewed });
      return true;
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
      if (this.stored.session?.refreshToken === session.refreshToken) this.endSession(error.code);
      return false;
    }
  }

  private endSession(code: string): void {
    if (this.stored.session === undefined) return;
    this.update({ ...this.stored, session: undefined });
    this.options.onSessionEnded?.(code);
  }

  private deviceRevoked(): void {
    if (this.stored.device === undefined) return;
    this.signer = undefined;
    this.update({});
    this.options.onDeviceRevoked?.();
  }

  private update(credentials: StoredCredentials): void {
    this.stored = credentials;
    this.options.onCredentialsChange?.(credentials);
  }
}

/** Drops trailing slashes in linear time (a `/\/+$/` regex backtracks on long runs of `/`). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') end -= 1;
  return url.slice(0, end);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
