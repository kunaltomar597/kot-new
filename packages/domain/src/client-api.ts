import { compareVersionText } from './rollout.js';
import { parseVersion } from './semver.js';

/**
 * The client API's version and the N-1 rule (UPD-006, P7-04d). The local server's API to its apps
 * (the console, the waiter app, the table tablet) has a version `<major>.<minor>`: the major is the
 * `/api/v<major>` path and the minor goes up when a release changes what clients send or read. A
 * server serves its own minor and the one before it, so phones and tablets that update after the
 * restaurant PC keep working; an app older than that is refused and told to update. Pure; the
 * server, the API client and the release tooling act on it.
 */

export interface ClientApiVersion {
  readonly major: number;
  readonly minor: number;
}

const API_VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

/** `1.4` → `{ major: 1, minor: 4 }`; undefined for anything else. */
export function parseClientApiVersion(text: string): ClientApiVersion | undefined {
  const match = API_VERSION.exec(text);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatClientApiVersion(version: ClientApiVersion): string {
  return `${String(version.major)}.${String(version.minor)}`;
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareClientApi(a: ClientApiVersion, b: ClientApiVersion): number {
  return a.major === b.major ? a.minor - b.minor : a.major - b.major;
}

/**
 * The oldest client API a server speaking `current` still serves: the minor before it (N-1). A
 * new major (`2.0`) serves only itself; it would come with its own `/api/v2` paths.
 */
export function oldestServedClientApi(current: ClientApiVersion): ClientApiVersion {
  return { major: current.major, minor: Math.max(0, current.minor - 1) };
}

/**
 * How an app's client API stands against the server's:
 * - `CURRENT`: the server's own;
 * - `PREVIOUS`: older but still served (N-1); it stops working at the server's next minor, so
 *   update it soon;
 * - `TOO_OLD`: refused (426 `CLIENT_TOO_OLD`); the app must be updated;
 * - `NEWER`: newer than the server (the app updated first). It is served: the server checks every
 *   request against its own contracts, so the app works as far as the server's API reaches, and
 *   the restaurant PC should be updated;
 * - `UNKNOWN`: the app has not said (paired before P7-04d, a pager, a tool).
 */
export const CLIENT_COMPATIBILITIES = [
  'CURRENT',
  'PREVIOUS',
  'TOO_OLD',
  'NEWER',
  'UNKNOWN',
] as const;
export type ClientCompatibility = (typeof CLIENT_COMPATIBILITIES)[number];

export function clientCompatibility(
  server: ClientApiVersion,
  client: ClientApiVersion | undefined,
): ClientCompatibility {
  if (client === undefined) return 'UNKNOWN';
  const order = compareClientApi(client, server);
  if (order === 0) return 'CURRENT';
  if (order > 0) return 'NEWER';
  return compareClientApi(client, oldestServedClientApi(server)) >= 0 ? 'PREVIOUS' : 'TOO_OLD';
}

/** Whether the server serves this app at all (everything but `TOO_OLD`). */
export function isClientServed(
  server: ClientApiVersion,
  client: ClientApiVersion | undefined,
): boolean {
  return clientCompatibility(server, client) !== 'TOO_OLD';
}

/**
 * What an app says about itself in the `x-rp-client` header and the socket handshake:
 * `<kind>/<app version> api/<major>.<minor>`, for example `waiter-app/1.4.2 api/1.3`.
 */
export interface ClientIdentity {
  /** `console`, `waiter-app`, `table-tablet`; other names are kept as they are. */
  readonly kind: string;
  readonly version: string;
  readonly api: ClientApiVersion;
}

const IDENTITY =
  /^([a-z][a-z0-9-]{0,39})\/([0-9A-Za-z][0-9A-Za-z.+-]{0,39}) api\/((?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2}))$/;

/** Undefined for a missing or malformed identity: such a request is served as `UNKNOWN`. */
export function parseClientIdentity(text: string | undefined): ClientIdentity | undefined {
  if (text === undefined) return undefined;
  const match = IDENTITY.exec(text.trim());
  if (match === null) return undefined;
  const [, kind = '', version = '', api = ''] = match;
  const parsed = parseClientApiVersion(api);
  return parsed === undefined ? undefined : { kind, version, api: parsed };
}

export function formatClientIdentity(identity: ClientIdentity): string {
  return `${identity.kind}/${identity.version} api/${formatClientApiVersion(identity.api)}`;
}

// ---------------------------------------------------------------- the version matrix

/** When a client API version was first released: the RESTAURANT_PC release that shipped it. */
export interface ClientApiRelease {
  readonly api: string;
  readonly since: string;
}

/**
 * The first release whose apps speak `api` or newer: apps from that version on work with a server
 * that serves `api`. Undefined when no release speaks it yet (or the history is out of order).
 */
export function firstReleaseSpeaking(
  history: readonly ClientApiRelease[],
  api: ClientApiVersion,
): string | undefined {
  let first: string | undefined;
  for (const entry of history) {
    const version = parseClientApiVersion(entry.api);
    if (version === undefined || parseVersion(entry.since) === undefined) continue;
    if (compareClientApi(version, api) < 0) continue;
    if (first === undefined || compareVersionText(entry.since, first) < 0) first = entry.since;
  }
  return first;
}

export interface VersionMatrixInput {
  /** The RESTAURANT_PC release, e.g. `1.4.0`. */
  readonly release: string;
  /** The client API this release's server speaks, e.g. `1.3`. */
  readonly clientApi: string;
  readonly history: readonly ClientApiRelease[];
  /** What the release installs on the PC and what it runs on, by name. */
  readonly components: readonly { readonly name: string; readonly version: string }[];
  /** The apps that talk to the server, each with the version it is built at in this release. */
  readonly clients: readonly { readonly kind: string; readonly version: string }[];
  /** The pagers' MQTT protocol (P2-04). */
  readonly pagerProtocol: number;
}

export interface VersionMatrix {
  readonly release: string;
  readonly clientApi: { readonly current: string; readonly oldest: string };
  readonly components: readonly { readonly name: string; readonly version: string }[];
  /**
   * Each app: the version this release builds, and the oldest version of it the server serves
   * (null when no release speaks the oldest API yet: only this release's builds).
   */
  readonly clients: readonly {
    readonly kind: string;
    readonly version: string;
    readonly minimumVersion: string | null;
  }[];
  readonly pagerProtocol: number;
}

/**
 * The component version matrix published with every release (UPD-006): what the release
 * contains, the client API range its server serves, and so the oldest app builds that keep
 * working with it. Apps carry the release's version (the release pipeline sets it), so the oldest
 * served build of every app is the first release that spoke the oldest served API.
 */
export function buildVersionMatrix(input: VersionMatrixInput): VersionMatrix {
  const current = parseClientApiVersion(input.clientApi);
  if (current === undefined) throw new RangeError(`Not a client API version: ${input.clientApi}`);
  if (parseVersion(input.release) === undefined) {
    throw new RangeError(`Not a release version: ${input.release}`);
  }
  const oldest = oldestServedClientApi(current);
  const minimumVersion = firstReleaseSpeaking(input.history, oldest) ?? null;
  return {
    release: input.release,
    clientApi: {
      current: formatClientApiVersion(current),
      oldest: formatClientApiVersion(oldest),
    },
    components: [...input.components],
    clients: input.clients.map((client) => ({ ...client, minimumVersion })),
    pagerProtocol: input.pagerProtocol,
  };
}
