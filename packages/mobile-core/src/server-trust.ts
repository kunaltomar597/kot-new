import { InvalidServerAddressError, normalizeServerUrl } from './server-url.js';

/** A server's LAN certificate authority as downloaded before pairing (ADR-0011). */
export interface ServerAuthority {
  /** The CA certificate, PEM. */
  readonly certificate: string;
  /** SHA-256 of the certificate, computed on the device: `AB:CD:…:EF`. */
  readonly sha256: string;
}

/**
 * How the device trusts the local server's TLS (ADR-0011, SEC-010): the Android module in the
 * apps. Once a CA is pinned, the device's HTTP and WebSocket clients trust only it for that server.
 */
export interface ServerTrust {
  /** Downloads the server's CA without trusting the connection: the device does not trust it yet. */
  fetchAuthority(serverUrl: string): Promise<ServerAuthority>;
  /** Pins the CA for the server from now on; resolves its fingerprint. */
  pin(certificate: string, serverUrl: string): Promise<string>;
  /** Forgets the pinned CA (the device was unpaired). */
  clear(): Promise<void>;
}

/** Where a device may pair: an address a person typed, or those in the manager's QR code. */
export interface PairingTarget {
  /** Server addresses to try, e.g. `192.168.1.20:8443` or `https://192.168.1.20:8443`. */
  readonly servers: readonly string[];
  /** The fingerprint of the server's CA from the QR code (`ca`). */
  readonly caSha256?: string;
}

/** A server that answered, with the CA to pin when it serves TLS. */
export interface FoundServer {
  readonly serverUrl: string;
  /** The server's CA; undefined for a development server without TLS. */
  readonly authority: ServerAuthority | undefined;
  /**
   * Whether the CA matched the QR code's fingerprint. When it has a CA that is not verified (an
   * address was typed), a person compares its fingerprint with the server's before pairing.
   */
  readonly verified: boolean;
}

/** None of the addresses answered. */
export class ServerUnreachableError extends Error {
  constructor(readonly servers: readonly string[]) {
    super('The server did not answer. Check that this device is on the restaurant Wi-Fi.');
    this.name = 'ServerUnreachableError';
  }
}

/** The server's CA is not the one in the pairing QR code: someone may be in between. */
export class ServerMismatchError extends Error {
  constructor() {
    super('The server’s certificate does not match the pairing code. Do not pair this device.');
    this.name = 'ServerMismatchError';
  }
}

/** Pairing over TLS was asked for without a CA that was checked first. */
export class UnverifiedServerError extends Error {
  constructor() {
    super('Check the server’s certificate before pairing over a secure connection.');
    this.name = 'UnverifiedServerError';
  }
}

export interface FindServerOptions {
  readonly trust?: ServerTrust;
  readonly fetch?: typeof fetch;
  /** How long an address may take to answer; 5 s by default. */
  readonly timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Finds the server among the addresses to pair with (AUTH-007, ADR-0011). Every address is tried
 * at once and the first to answer wins; a server over TLS must present the CA whose fingerprint
 * the QR code carries, so a stranger on another address cannot stand in for it.
 */
export async function findServer(
  target: PairingTarget,
  options: FindServerOptions = {},
): Promise<FoundServer> {
  const expected = target.caSha256;
  const given = [...new Set(target.servers.map(normalizeServerUrl))];
  // A server whose CA the QR code names serves TLS: a plain-HTTP address is not tried for it.
  const urls = expected === undefined ? given : given.filter((url) => url.startsWith('https:'));
  if (urls.length === 0) throw new InvalidServerAddressError();
  const { trust } = options;
  const probes = urls.map(async (serverUrl): Promise<FoundServer> => {
    if (trust !== undefined && serverUrl.startsWith('https:')) {
      const authority = await trust.fetchAuthority(serverUrl);
      if (expected !== undefined && authority.sha256 !== expected) throw new ServerMismatchError();
      return { serverUrl, authority, verified: expected !== undefined };
    }
    // Without TLS (a development server) any answer will do; one address needs no probe.
    if (urls.length > 1) await answers(serverUrl, options);
    return { serverUrl, authority: undefined, verified: false };
  });
  const outcomes = await firstFulfilled(probes);
  if ('found' in outcomes) return outcomes.found;
  // A server that answered with the wrong CA is worth saying so, rather than "unreachable".
  if (outcomes.errors.some((error) => error instanceof ServerMismatchError)) {
    throw new ServerMismatchError();
  }
  throw new ServerUnreachableError(urls);
}

/** Resolves once the server at `serverUrl` answers at all; rejects when it does not in time. */
async function answers(serverUrl: string, options: FindServerOptions): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    await (options.fetch ?? fetch)(`${serverUrl}/api/v1/health`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The first probe to succeed, or every probe's error once all have failed. */
function firstFulfilled<T>(
  probes: readonly Promise<T>[],
): Promise<{ found: T } | { errors: unknown[] }> {
  return new Promise((resolve) => {
    const errors: unknown[] = [];
    for (const probe of probes) {
      probe.then(
        (found) => {
          resolve({ found });
        },
        (error: unknown) => {
          errors.push(error);
          if (errors.length === probes.length) resolve({ errors });
        },
      );
    }
  });
}
