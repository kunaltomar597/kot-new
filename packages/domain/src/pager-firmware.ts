import { compareVersionText } from './rollout.js';

/**
 * Pager firmware over the air through the restaurant PC (PGR-011, UPD-001, P2-04b). The vendor
 * releases signed firmware in the Control Plane; the PC downloads and checks it, then offers it to
 * each pager over MQTT when the pager is free, and the pager downloads it from the PC over HTTPS,
 * checks the signature itself (secure boot), boots it from its other partition and rolls back by
 * itself when it does not come up. Pure; the server's firmware service acts on it.
 */

/** The ESP-IDF project name every pager firmware image carries (`esp_app_desc_t.project_name`). */
export const PAGER_FIRMWARE_PROJECT = 'rp-pager';

/** ESP32-S3's chip id in an ESP-IDF image header (PGR-001, PGR-004). */
export const PAGER_FIRMWARE_CHIP_ID = 9;

/** The largest firmware image the PC takes: the pager's app partitions are smaller. */
export const PAGER_FIRMWARE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * When a pager takes new firmware. Not BRD ⚙ values: the vendor's defaults, the same everywhere.
 * - `minBatteryPercent`: a pager off its charger needs this much to download and reboot;
 * - `maxAttempts`: failed offers of one version to one pager before it is left alone, until a
 *   manager presses "Update now" again;
 * - `retryAfterMs`: the wait after a failed attempt;
 * - `answerTimeoutMs`: an offer the pager neither finished nor reported on in this time failed;
 * - `maxConcurrent`: pagers updating at once, so the floor never loses many at a time.
 */
export const PAGER_FIRMWARE_RULES = {
  minBatteryPercent: 30,
  maxAttempts: 3,
  retryAfterMs: 30 * 60_000,
  answerTimeoutMs: 15 * 60_000,
  maxConcurrent: 2,
} as const;

export type PagerFirmwareRules = { readonly [K in keyof typeof PAGER_FIRMWARE_RULES]: number };

/**
 * PAGER-T4: firmware whose anti-rollback version (`secure_version` in its app description) is
 * lower than that of the firmware the PC serves is never passed on, even when its version number
 * is newer: it would take the pagers back to code with a flaw the vendor has closed. Pagers burn
 * the version into an eFuse as well (P2-05); this keeps the PC from offering what they refuse.
 */
export function lowersSecureVersion(candidate: number, served: number | null): boolean {
  return served !== null && candidate < served;
}

/**
 * One pager and one firmware version:
 * - `WAITING`: a manager pressed "Update now"; not offered yet;
 * - `OFFERED`: the offer went to the pager;
 * - `DOWNLOADING`: the pager is downloading it (it fetched the file or said so);
 * - `UPDATED`: the pager runs it;
 * - `FAILED`: the download, the pager's checks or the answer failed; tried again later;
 * - `ROLLED_BACK`: the pager booted it, it did not come up, and the pager went back to its
 *   previous firmware. It is not offered to that pager again.
 */
export const PAGER_FIRMWARE_STATES = [
  'WAITING',
  'OFFERED',
  'DOWNLOADING',
  'UPDATED',
  'FAILED',
  'ROLLED_BACK',
] as const;
export type PagerFirmwareState = (typeof PAGER_FIRMWARE_STATES)[number];

export interface PagerFirmwareAttempt {
  readonly state: PagerFirmwareState;
  /** Offers made so far. */
  readonly attempts: number;
  readonly changedAt: Date;
  /** A manager's "Update now" for this version (UPD-004), or null. */
  readonly requestedAt: Date | null;
}

export interface PagerFirmwarePager {
  /** Connected to the broker now. */
  readonly connected: boolean;
  /** The version its last heartbeat reported; null before any. */
  readonly firmware: string | null;
  readonly batteryPercent: number | null;
  readonly charging: boolean;
  /** Given to a person (PGR-012). */
  readonly worn: boolean;
  /** Alerts on it the wearer has not acknowledged. */
  readonly openAlerts: number;
}

/**
 * Why a pager waits for its update:
 * - `NOT_CONNECTED`: it is not connected to the PC;
 * - `BATTERY`: off its charger with too little battery;
 * - `ALERTS`: its wearer has alerts on it;
 * - `IN_SERVICE`: someone wears it and it is outside the maintenance window ⚙, unless a manager
 *   pressed "Update now";
 * - `RETRY_LATER`: the last attempt failed a short while ago;
 * - `OTHERS_UPDATING`: enough other pagers are updating now.
 */
export type PagerFirmwareWait =
  'NOT_CONNECTED' | 'BATTERY' | 'ALERTS' | 'IN_SERVICE' | 'RETRY_LATER' | 'OTHERS_UPDATING';

export type PagerFirmwareVerdict =
  | { readonly kind: 'UP_TO_DATE' }
  | { readonly kind: 'OFFER' }
  | { readonly kind: 'IN_PROGRESS' }
  | { readonly kind: 'WAIT'; readonly waitFor: PagerFirmwareWait }
  /** Rolled back, or failed `maxAttempts` times: left alone until "Update now". */
  | { readonly kind: 'GAVE_UP' };

export interface PagerFirmwareInput {
  readonly pager: PagerFirmwarePager;
  /** The version the PC serves. */
  readonly served: string;
  /** This pager's attempt at `served`, or null. */
  readonly attempt: PagerFirmwareAttempt | null;
  readonly now: Date;
  /** Inside `updates.maintenanceWindow` ⚙ (UPD-004). */
  readonly inMaintenanceWindow: boolean;
  /** Other pagers with an offer in progress. */
  readonly updatingNow: number;
  readonly rules?: PagerFirmwareRules;
}

/** Whether an offer has gone unanswered too long: it counts as a failed attempt. */
export function pagerFirmwareTimedOut(
  attempt: Pick<PagerFirmwareAttempt, 'state' | 'changedAt'>,
  now: Date,
  rules: PagerFirmwareRules = PAGER_FIRMWARE_RULES,
): boolean {
  return (
    (attempt.state === 'OFFERED' || attempt.state === 'DOWNLOADING') &&
    now.getTime() - attempt.changedAt.getTime() >= rules.answerTimeoutMs
  );
}

/**
 * PGR-011, UPD-004: whether the PC offers its firmware to a pager now. A pager updates only when
 * it is free: connected, charged enough, no alert waiting on it, and either nobody wears it or it
 * is inside the maintenance window (or a manager pressed "Update now"). A few at a time; a failed
 * attempt is tried again later, a few times; a rollback is never tried again by itself.
 */
export function pagerFirmwareVerdict(input: PagerFirmwareInput): PagerFirmwareVerdict {
  const { pager, attempt, now } = input;
  const rules = input.rules ?? PAGER_FIRMWARE_RULES;
  if (pager.firmware !== null && compareVersionText(pager.firmware, input.served) >= 0) {
    return { kind: 'UP_TO_DATE' };
  }
  if (attempt !== null) {
    if (attempt.state === 'ROLLED_BACK') return { kind: 'GAVE_UP' };
    const timedOut = pagerFirmwareTimedOut(attempt, now, rules);
    if ((attempt.state === 'OFFERED' || attempt.state === 'DOWNLOADING') && !timedOut) {
      return { kind: 'IN_PROGRESS' };
    }
    if (attempt.state === 'FAILED' || timedOut) {
      if (attempt.attempts >= rules.maxAttempts) return { kind: 'GAVE_UP' };
      const failedAt =
        attempt.changedAt.getTime() + (attempt.state === 'FAILED' ? 0 : rules.answerTimeoutMs);
      if (now.getTime() < failedAt + rules.retryAfterMs) {
        return { kind: 'WAIT', waitFor: 'RETRY_LATER' };
      }
    }
  }
  if (!pager.connected) return { kind: 'WAIT', waitFor: 'NOT_CONNECTED' };
  if (
    !pager.charging &&
    (pager.batteryPercent === null || pager.batteryPercent < rules.minBatteryPercent)
  ) {
    return { kind: 'WAIT', waitFor: 'BATTERY' };
  }
  if (pager.openAlerts > 0) return { kind: 'WAIT', waitFor: 'ALERTS' };
  const requested = attempt?.requestedAt !== null && attempt?.requestedAt !== undefined;
  if (pager.worn && !input.inMaintenanceWindow && !requested) {
    return { kind: 'WAIT', waitFor: 'IN_SERVICE' };
  }
  if (input.updatingNow >= rules.maxConcurrent) return { kind: 'WAIT', waitFor: 'OTHERS_UPDATING' };
  return { kind: 'OFFER' };
}
