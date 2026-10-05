import { compareClientApi, parseClientApiVersion } from './client-api.js';

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
