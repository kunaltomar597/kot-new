import { z } from 'zod';
import { NotificationEventType } from './alerts.js';
import { Id, Timestamp } from './common.js';

/**
 * Wrist pagers over MQTT (P2-04, PGR-005 to PGR-008, PGR-011, PGR-012, SEC-012): the messages on
 * the broker and the manager's pager administration. Topics: `rp/<restaurant>/pagers/<device>/alerts`
 * and `.../ota` (server → pager, QoS 1), `.../ack` and `.../heartbeat` (pager → server).
 */

/**
 * The pagers' MQTT protocol (topics and messages below), for the version matrix (UPD-006). It goes
 * up when a release changes them; the server keeps serving the version before (N-1).
 */
export const PAGER_PROTOCOL_VERSION = 1;

export const VibrationPattern = z.enum(['ONE_LONG', 'TWO_SHORT', 'THREE', 'ONE_SHORT']);
export type VibrationPattern = z.infer<typeof VibrationPattern>;

/**
 * Server → pager (QoS 1). The pager shows each `alertId` once and buzzes again only for a higher
 * `seq` (a repeat); `ACKNOWLEDGED` or `CLEARED` removes it from the queue (PGR-006, PGR-008).
 */
export const PagerAlertMessage = z.object({
  alertId: Id,
  seq: z.int().nonnegative(),
  state: z.enum(['ALERT', 'ACKNOWLEDGED', 'CLEARED']),
  type: NotificationEventType,
  lines: z.tuple([z.string().max(12), z.string().max(12)]),
  vibration: VibrationPattern,
  sentAt: Timestamp,
});
export type PagerAlertMessage = z.infer<typeof PagerAlertMessage>;

/** Pager → server: the wearer pressed the button on this alert (NTF-004). */
export const PagerAckMessage = z.strictObject({ alertId: Id });
export type PagerAckMessage = z.infer<typeof PagerAckMessage>;

/**
 * A pager's word on a firmware offer (PGR-011, P2-04b), in its heartbeats until the server answers
 * with the next offer or the pager runs the version:
 * - `DOWNLOADING`: it took the offer and is downloading;
 * - `FAILED`: the download, its SHA-256 or its signature check failed, or the offer expired;
 * - `ROLLED_BACK`: it booted the version, which did not come up, and went back to the firmware it
 *   runs now (ESP-IDF's last invalid partition).
 */
export const PagerOtaReport = z.strictObject({
  version: z.string().min(1).max(32),
  /**
   * The offer's `attempt` (keep it across the reboot for ROLLED_BACK). A report about another
   * offer is ignored; without it the report is taken as about the latest offer.
   */
  attempt: z.int().positive().optional(),
  state: z.enum(['DOWNLOADING', 'FAILED', 'ROLLED_BACK']),
  /** Why, short; for the manager and support. */
  error: z.string().max(120).optional(),
});
export type PagerOtaReport = z.infer<typeof PagerOtaReport>;

/** Pager → server every 30 s ⚙ (PGR-007). */
export const PagerHeartbeat = z.strictObject({
  battery: z.int().min(0).max(100),
  rssi: z.int().min(-127).max(0),
  firmware: z.string().min(1).max(32),
  /** On its charger (P2-04b): it may update with any battery. Absent: not charging. */
  charging: z.boolean().optional(),
  /** Its last firmware offer, until it runs the version or a new offer comes (P2-04b). */
  ota: PagerOtaReport.optional(),
});
export type PagerHeartbeat = z.infer<typeof PagerHeartbeat>;

/**
 * Server → pager on `.../ota` (QoS 1, PGR-011): firmware to update to. The pager downloads it
 * over HTTPS from the host it reaches the broker at, on `port` and `path` (the path carries a
 * download token that expires at `expiresAt`), pinning the restaurant's CA as for MQTT. It checks
 * the size and SHA-256, writes it to its other OTA partition, where ESP-IDF checks the secure boot
 * signature, boots it, and marks it valid once it is connected to the broker again, or rolls back.
 * An offer for the version it runs is ignored.
 */
export const PagerFirmwareOffer = z.object({
  version: z.string().min(1).max(32),
  /** Numbers the offers of this version to this pager; echoed in the heartbeat's `ota`. */
  attempt: z.int().positive(),
  port: z.int().min(1).max(65_535),
  path: z.string().regex(/^\/api\/v1\/pager-firmware\/[A-Za-z0-9_-]{43}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.int().positive(),
  expiresAt: Timestamp,
});
export type PagerFirmwareOffer = z.infer<typeof PagerFirmwareOffer>;

/** A pager's serial, as on its label and its pairing screen: 4 to 32 letters, digits or dashes. */
export const PagerSerial = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{4,32}$/);
export type PagerSerial = z.infer<typeof PagerSerial>;

/**
 * What a pager's QR code holds (PGR-012, P2-04b2): `RP-PAGER:<serial>`, shown on its pairing screen
 * (P2-05) and printed on its label. Upper case, so the code uses QR's compact alphanumeric mode and
 * stays readable on a small screen. A code with the bare serial (a supplier's label) is read too.
 */
export const PAGER_QR_PREFIX = 'RP-PAGER:';

/** The text of a pager's QR code for its serial. */
export function pagerQrText(serial: string): string {
  return `${PAGER_QR_PREFIX}${serial}`;
}

/**
 * The serial in a scanned QR code, or undefined when the code is not a pager's (a pairing code, a
 * link, a table's code). The prefix may be in any case; spaces and line ends around it are ignored.
 */
export function pagerSerialFromQr(text: string): PagerSerial | undefined {
  const trimmed = text.trim();
  const serial = trimmed.toUpperCase().startsWith(PAGER_QR_PREFIX)
    ? trimmed.slice(PAGER_QR_PREFIX.length)
    : trimmed;
  const parsed = PagerSerial.safeParse(serial);
  return parsed.success ? parsed.data : undefined;
}

/** PGR-012: register a pager from its serial (the QR on its back) and optionally assign it. */
export const CreatePagerRequest = z.strictObject({
  serial: PagerSerial,
  name: z.string().trim().min(1).max(60),
  staffId: Id.nullable(),
});
export type CreatePagerRequest = z.infer<typeof CreatePagerRequest>;

/** What is written into the pager when it is set up; the password is shown only now. */
export const PagerCredentialResponse = z.object({
  deviceId: Id,
  mqttUsername: z.string(),
  mqttPassword: z.string(),
  alertsTopic: z.string(),
  ackTopic: z.string(),
  heartbeatTopic: z.string(),
  mqttPort: z.int().positive(),
});
export type PagerCredentialResponse = z.infer<typeof PagerCredentialResponse>;

/** PGR-012, PGR-014: give the pager to a waiter or a manager, or take it back (null). */
export const AssignPagerRequest = z.strictObject({ staffId: Id.nullable() });
export type AssignPagerRequest = z.infer<typeof AssignPagerRequest>;

export const PagerParams = z.strictObject({ deviceId: Id });
export type PagerParams = z.infer<typeof PagerParams>;

export const PagerView = z.object({
  deviceId: Id,
  name: z.string(),
  serial: z.string().nullable(),
  staffId: Id.nullable(),
  online: z.boolean(),
  batteryPercent: z.int().nullable(),
  rssi: z.int().nullable(),
  firmwareVersion: z.string().nullable(),
  lastSeenAt: Timestamp.nullable(),
});
export type PagerView = z.infer<typeof PagerView>;

/**
 * The restaurant's pagers by name, with the low-battery level (PGR-013 ⚙ `pager.lowBatteryPercent`)
 * at or below which a pager is shown as low.
 */
export const PagerListResponse = z.object({
  pagers: z.array(PagerView),
  lowBatteryPercent: z.int().min(0).max(100),
});
export type PagerListResponse = z.infer<typeof PagerListResponse>;

/**
 * WTR-014: the signed-in person's own pager, or null when they wear none, with the low-battery
 * level (PGR-013 ⚙ `pager.lowBatteryPercent`) at or below which the app warns them.
 */
export const MyPagerResponse = z.object({
  pager: PagerView.nullable(),
  lowBatteryPercent: z.int().min(0).max(100),
});
export type MyPagerResponse = z.infer<typeof MyPagerResponse>;

// ---------------------------------------------------------------- firmware (PGR-011, P2-04b)

/**
 * Why the PC has no new firmware for its pagers yet. Download problems are tried again later;
 * a release that fails a check of the image is refused and never tried again:
 * - `NOT_HTTPS`, `HTTP_STATUS`, `NETWORK`: the download (tried again);
 * - `SIZE`, `HASH`, `TOO_LARGE`: it is not the file the release describes (refused);
 * - `NOT_AN_IMAGE`, `WRONG_CHIP`, `WRONG_PROJECT`, `VERSION_MISMATCH`: not this pager's firmware
 *   image of that version (refused);
 * - `NOT_SIGNED`, `UNTRUSTED_KEY`, `BAD_SIGNATURE`: its secure boot signature is missing, from a
 *   key the pagers do not trust, or wrong (refused);
 * - `NO_TRUSTED_KEY`: this software trusts no firmware key yet (tried again after an update).
 */
export const PAGER_FIRMWARE_PROBLEMS = [
  'NOT_HTTPS',
  'HTTP_STATUS',
  'NETWORK',
  'SIZE',
  'HASH',
  'TOO_LARGE',
  'NOT_AN_IMAGE',
  'WRONG_CHIP',
  'WRONG_PROJECT',
  'VERSION_MISMATCH',
  'NOT_SIGNED',
  'UNTRUSTED_KEY',
  'BAD_SIGNATURE',
  'NO_TRUSTED_KEY',
] as const;
export const PagerFirmwareProblem = z.enum(PAGER_FIRMWARE_PROBLEMS);
export type PagerFirmwareProblem = z.infer<typeof PagerFirmwareProblem>;

/** The firmware this PC offers its pagers, checked (PGR-011). */
export const ServedPagerFirmware = z.object({
  version: z.string(),
  sha256: z.string(),
  sizeBytes: z.int().positive(),
  acceptedAt: Timestamp,
  /** The vendor halted its rollout: no pager is offered it any more (UPD-003). */
  halted: z.boolean(),
});
export type ServedPagerFirmware = z.infer<typeof ServedPagerFirmware>;

/** Why a pager waits for its update (`@rp/domain` `PagerFirmwareWait`). */
export const PagerFirmwareWait = z.enum([
  'NOT_CONNECTED',
  'BATTERY',
  'ALERTS',
  'IN_SERVICE',
  'RETRY_LATER',
  'OTHERS_UPDATING',
]);
export type PagerFirmwareWait = z.infer<typeof PagerFirmwareWait>;

/**
 * One pager and the firmware the PC serves:
 * - `UP_TO_DATE`: it runs that version or a newer one;
 * - `WAITING`: for `waitFor`;
 * - `UPDATING`: it has the offer, or is downloading;
 * - `GAVE_UP`: it rolled back from the version, or failed it every time; "Update now" tries again.
 */
export const PagerFirmwarePagerView = z.object({
  deviceId: Id,
  status: z.enum(['UP_TO_DATE', 'WAITING', 'UPDATING', 'GAVE_UP']),
  waitFor: PagerFirmwareWait.nullable(),
  attempts: z.int().nonnegative(),
  rolledBack: z.boolean(),
  /** The last failure, in the pager's or the server's words; null without one. */
  error: z.string().nullable(),
  /** A manager pressed "Update now" for this version. */
  requested: z.boolean(),
});
export type PagerFirmwarePagerView = z.infer<typeof PagerFirmwarePagerView>;

/**
 * The Pagers page's firmware (PGR-011): what this PC serves, a release on its way or refused, and
 * each pager's update. Without firmware there is nothing to show per pager.
 */
export const PagerFirmwareResponse = z.object({
  firmware: ServedPagerFirmware.nullable(),
  /** A newer release the Control Plane offers that is not served yet. */
  incoming: z
    .object({
      version: z.string(),
      /** Null while it downloads; the reason when it failed. */
      problem: z
        .object({
          code: PagerFirmwareProblem,
          message: z.string(),
          at: Timestamp,
          /** It failed a check: never tried again. */
          refused: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
  pagers: z.array(PagerFirmwarePagerView),
});
export type PagerFirmwareResponse = z.infer<typeof PagerFirmwareResponse>;

export const PagerFirmwareDownloadParams = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PagerFirmwareDownloadParams = z.infer<typeof PagerFirmwareDownloadParams>;
