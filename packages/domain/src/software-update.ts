import { inTimeWindow, timeOfDayOf } from './business-date.js';
import { compareVersionText } from './rollout.js';

/**
 * Software updates on the restaurant PC (UPD-004, UPD-005, P7-04c): whether the update agent may
 * install the release on offer now, and how long it waits before downloading again after a
 * failure. Pure; the server's update agent acts on it.
 */

export interface UpdateTimingInput {
  readonly now: Date;
  /** The restaurant's time zone: the maintenance window is local time. */
  readonly timeZone: string;
  /** `updates.maintenanceWindow` ⚙ (default 03:00-06:00); one that ends before it starts runs past midnight. */
  readonly window: { readonly start: string; readonly end: string };
  readonly release: { readonly version: string; readonly securityCritical: boolean };
  /** A manager's "Install now" (UPD-004), or null. */
  readonly approval: { readonly version: string; readonly approvedAt: Date } | null;
  /** Table sessions open now. */
  readonly openTables: number;
  /** The last update on this PC that failed or was rolled back, or null. */
  readonly lastFailure: { readonly version: string; readonly at: Date } | null;
}

/**
 * Why an update waits:
 * - `WINDOW`: until the maintenance window, unless a manager presses "Install now";
 * - `OPEN_TABLES`: until every table is closed; a security-critical release also goes ahead with
 *   a manager's "Install now";
 * - `RETRY_APPROVAL`: this version failed here before and is not tried again by itself; a
 *   manager's "Install now" after the failure tries again.
 */
export type UpdateWait = 'WINDOW' | 'OPEN_TABLES' | 'RETRY_APPROVAL';

export type UpdateTiming =
  | { readonly install: true; readonly trigger: 'WINDOW' | 'APPROVED' }
  | { readonly install: false; readonly waitFor: UpdateWait };

/**
 * UPD-004: an update installs only inside the maintenance window or when a manager pressed
 * "Install now", and never while tables are open unless the release is security-critical and a
 * manager approved it. An approval counts for its own version only, and after a failure only when
 * it was given after the failure.
 */
export function updateTiming(input: UpdateTimingInput): UpdateTiming {
  const { release, approval, lastFailure } = input;
  const failedBefore = lastFailure !== null && lastFailure.version === release.version;
  const approved =
    approval !== null &&
    approval.version === release.version &&
    (!failedBefore || approval.approvedAt.getTime() > lastFailure.at.getTime());
  if (failedBefore && !approved) return { install: false, waitFor: 'RETRY_APPROVAL' };
  const inWindow = inTimeWindow(timeOfDayOf(input.now, input.timeZone), input.window);
  if (!inWindow && !approved) return { install: false, waitFor: 'WINDOW' };
  if (input.openTables > 0 && !(release.securityCritical && approved)) {
    return { install: false, waitFor: 'OPEN_TABLES' };
  }
  return { install: true, trigger: approved ? 'APPROVED' : 'WINDOW' };
}

/** Whether `offered` is newer than the version installed (the agent never goes back by itself). */
export function isNewerVersion(offered: string, installed: string): boolean {
  return compareVersionText(offered, installed) > 0;
}

/** The first wait after a failed download; it doubles with each failure in a row. */
export const UPDATE_DOWNLOAD_RETRY_MS = 5 * 60_000;
/** The longest wait between downloads. */
export const UPDATE_DOWNLOAD_RETRY_MAX_MS = 6 * 60 * 60_000;

/** How long to wait after `failures` failed downloads in a row (1 or more). */
export function updateDownloadRetryMs(failures: number): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 20);
  return Math.min(UPDATE_DOWNLOAD_RETRY_MS * 2 ** exponent, UPDATE_DOWNLOAD_RETRY_MAX_MS);
}

/**
 * How a PC checks the updates it installs (UPD-007), as its heartbeat says (P8-03b3b): `VENDOR`,
 * only installers with the vendor's Authenticode signature; `UNSIGNED`, a test build that also
 * takes unsigned installers, so anyone who can offer it one runs code as SYSTEM; `NONE`, a build
 * that can check no signature and installs no update.
 */
export const UPDATE_SIGNING = ['VENDOR', 'UNSIGNED', 'NONE'] as const;
export type UpdateSigning = (typeof UPDATE_SIGNING)[number];

/** The update settings built into a PC's installation (`updates` in its installation file). */
export function updateSigningOf(policy: {
  readonly publisher: string | null;
  readonly allowUnsigned: boolean;
}): UpdateSigning {
  // Allowing unsigned installers wins: one passes even where a publisher is named.
  if (policy.allowUnsigned) return 'UNSIGNED';
  return policy.publisher === null ? 'NONE' : 'VENDOR';
}
