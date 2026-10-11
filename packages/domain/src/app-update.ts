import { compareClientApi, parseClientApiVersion } from './client-api.js';
import { isNewerVersion } from './software-update.js';

/**
 * Over-the-air updates of the phones and tablets (UPD-001, UPD-006, P7-04e1). EAS Update can send
 * the waiter app and the table tablet new JavaScript at any time, but the restaurant PC updates
 * only in its maintenance window. So an app takes an update only when its restaurant's server
 * speaks the update's client API, and switches to it only when nobody is in the middle of
 * something. Pure; `@rp/mobile-core`'s `OtaUpdater` acts on it.
 */

/**
 * Whether a phone or tablet may take an update, given the server's client API range:
 * - `APPLY`: the server serves the update's API (its own or the one before, N-1);
 * - `WAIT_FOR_SERVER`: the update speaks a newer API than the server. It waits until the PC
 *   updates, then applies;
 * - `NOT_SERVED`: the update speaks an API the server no longer serves. It is never taken: the app
 *   would be refused (426 `CLIENT_TOO_OLD`);
 * - `UNKNOWN`: the update was published without its client API, or the server does not say its
 *   range (before P7-04d). It is not taken.
 */
export type OtaVerdict = 'APPLY' | 'WAIT_FOR_SERVER' | 'NOT_SERVED' | 'UNKNOWN';

export function otaUpdateVerdict(
  server: { readonly current: string; readonly oldest: string } | undefined,
  updateApi: string | undefined,
): OtaVerdict {
  const current = server === undefined ? undefined : parseClientApiVersion(server.current);
  const oldest = server === undefined ? undefined : parseClientApiVersion(server.oldest);
  const update = updateApi === undefined ? undefined : parseClientApiVersion(updateApi);
  if (current === undefined || oldest === undefined || update === undefined) return 'UNKNOWN';
  if (compareClientApi(update, current) > 0) return 'WAIT_FOR_SERVER';
  if (compareClientApi(update, oldest) < 0) return 'NOT_SERVED';
  return 'APPLY';
}

/**
 * Whether a downloaded update may restart the app now. It restarts the app's JavaScript, so it
 * waits while the device is in use: a person signed in on a waiter phone, guests at a tablet's
 * table, or the app off the screen. An app the server refuses is of no use as it is, so it
 * switches at once.
 */
export function mayApplyAppUpdate(input: {
  /** The server refuses this build (426 `CLIENT_TOO_OLD`). */
  readonly refused: boolean;
  /** The device is in use. */
  readonly busy: boolean;
}): boolean {
  return input.refused || !input.busy;
}

/**
 * Whether a phone or tablet takes the APK its restaurant PC serves (UPD-001, WTR-001, P7-04e2).
 * New native code comes as a new APK, which travels in the PC's installer: each PC serves the
 * builds of its own release.
 * - `OFFER`: the build is newer than the app installed, and the server speaks its client API;
 * - `UP_TO_DATE`: the app installed is the same version or newer;
 * - `NOT_SERVED`: the server does not serve the build's client API (it cannot happen with a
 *   build from the PC's own release; never installed);
 * - `UNKNOWN`: the app does not know its own version. Nothing is installed.
 */
export type ApkVerdict = 'OFFER' | 'UP_TO_DATE' | 'NOT_SERVED' | 'UNKNOWN';

export function apkUpdateVerdict(
  server: { readonly current: string; readonly oldest: string } | undefined,
  installedVersion: string | undefined,
  build: { readonly version: string; readonly clientApi: string },
): ApkVerdict {
  if (installedVersion === undefined) return 'UNKNOWN';
  if (!isNewerVersion(build.version, installedVersion)) return 'UP_TO_DATE';
  return otaUpdateVerdict(server, build.clientApi) === 'APPLY' ? 'OFFER' : 'NOT_SERVED';
}

/**
 * Whether a device installs an APK by itself, now. Android replaces the app, which stops it, so
 * only a table tablet that is its device's owner (MDM, TAB-001) installs with nobody asked, and
 * only between guests or when the server refuses the app as it is. A phone, or a tablet that is
 * not device owner, asks a person: Android shows its own confirmation.
 */
export function mayInstallApkUnattended(input: {
  /** The device may install without asking: a tablet that is device owner. */
  readonly silent: boolean;
  /** The server refuses this build (426 `CLIENT_TOO_OLD`). */
  readonly refused: boolean;
  /** The device is in use. */
  readonly busy: boolean;
}): boolean {
  return input.silent && mayApplyAppUpdate(input);
}
