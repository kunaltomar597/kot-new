import type { ClientApiRelease } from '@rp/domain';
import { z } from 'zod';

/**
 * The client API's version (UPD-006, P7-04d): what the local server's apps (the console, the
 * waiter app, the table tablet) speak, `<major>.<minor>`. The major is the `/api/v1` path; the
 * minor goes up at a release whose contracts changed since the last frozen version
 * (`pnpm contracts:freeze`, docs/runbooks/client-compatibility.md). The server serves its own
 * minor and the one before it (N-1); `pnpm contracts:compat` keeps the contracts serving both.
 */
export const CLIENT_API_VERSION = '1.0';

/**
 * The release that first shipped each client API version, oldest first; `pnpm contracts:freeze`
 * asks for the entry when a version is frozen. The version matrix derives the oldest app builds a
 * release still serves from it. Empty until the first release.
 */
export const CLIENT_API_HISTORY: readonly ClientApiRelease[] = [];

/**
 * Every app sends who it is on every request: `<kind>/<app version> api/<major>.<minor>`, e.g.
 * `waiter-app/1.4.2 api/1.0` (`formatClientIdentity` in `@rp/domain`). The socket handshake
 * carries the same text in `client`.
 */
export const CLIENT_HEADER = 'x-rp-client';

/** The apps that talk to the local server. */
export const CLIENT_KINDS = ['console', 'waiter-app', 'table-tablet'] as const;
export const ClientKind = z.enum(CLIENT_KINDS);
export type ClientKind = z.infer<typeof ClientKind>;

/**
 * Error codes of an app the server does not serve (HTTP 426, socket `connect_error`):
 * `CLIENT_TOO_OLD` asks for the app to be updated.
 */
export const CLIENT_TOO_OLD = 'CLIENT_TOO_OLD';

/** `1.4`: a client API version. */
export const ClientApiVersionText = z.string().regex(/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/);

/** The text an app sends in `x-rp-client` (checked by `parseClientIdentity`). */
export const ClientIdentityText = z.string().min(1).max(100);

/**
 * How an app's client API stands against the server's (`clientCompatibility` in `@rp/domain`):
 * CURRENT, PREVIOUS (served, update soon), TOO_OLD (refused), NEWER (served; update the PC) or
 * UNKNOWN (it has not said).
 */
export const ClientCompatibility = z.enum(['CURRENT', 'PREVIOUS', 'TOO_OLD', 'NEWER', 'UNKNOWN']);
export type ClientCompatibility = z.infer<typeof ClientCompatibility>;

/** The client API range a server serves. */
export const ClientApiRange = z.object({
  /** What it speaks. */
  current: ClientApiVersionText,
  /** The oldest it still serves (N-1). */
  oldest: ClientApiVersionText,
});
export type ClientApiRange = z.infer<typeof ClientApiRange>;

const ReleaseVersion = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
const ComponentName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/**
 * The component version matrix published with every release (UPD-006): what the RESTAURANT_PC
 * release installs and runs on, the client API range its server serves, each app's build in the
 * release with the oldest build the server still serves, and the pagers' protocol. Built by the
 * packaging step (`version-matrix.json`), published with the release to the Control Plane and
 * shown to vendor staff and on the restaurant's System page.
 */
export const VersionMatrix = z.object({
  release: ReleaseVersion,
  clientApi: ClientApiRange,
  /** `server`, `console`, `desktop`, `node`, `postgres`, `winsw`. */
  components: z
    .array(z.object({ name: ComponentName, version: z.string().min(1).max(64) }))
    .max(20),
  clients: z
    .array(
      z.object({
        kind: ComponentName,
        version: z.string().min(1).max(64),
        /** The oldest build the server serves; null when only this release's builds. */
        minimumVersion: ReleaseVersion.nullable(),
      }),
    )
    .max(10),
  /** The pagers' MQTT protocol (P2-04). */
  pagerProtocol: z.int().positive(),
});
export type VersionMatrix = z.infer<typeof VersionMatrix>;
