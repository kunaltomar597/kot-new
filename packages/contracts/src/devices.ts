import { z } from 'zod';
import { DeviceType, Id, Timestamp } from './common.js';
import { CaFingerprint } from './system.js';

/** Header carrying the device token on every request of a paired device (AUTH-007). */
export const DEVICE_TOKEN_HEADER = 'x-device-token';

/**
 * Key algorithms a device may pair with: Ed25519, or ECDSA P-256 with SHA-256 (what Android
 * Keystore, browsers' WebCrypto and the ESP32 support). Signatures are raw: 64 bytes for both
 * (r‖s for ECDSA, as WebCrypto produces them).
 */
export const DeviceKeyAlgorithm = z.enum(['Ed25519', 'ES256']);
export type DeviceKeyAlgorithm = z.infer<typeof DeviceKeyAlgorithm>;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

/** One-time pairing code, 8 characters from an alphabet without look-alikes, shown as XXXX-XXXX. */
export const PairingCode = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

/** What a device signs to prove it holds the key when pairing: `rp-pair:v1:<code>`. */
export function pairingProofMessage(code: string): string {
  return `rp-pair:v1:${code}`;
}

/** What a device signs to get a device token: `rp-device-token:v1:<deviceId>:<challenge>`. */
export function deviceTokenMessage(deviceId: string, challenge: string): string {
  return `rp-device-token:v1:${deviceId}:${challenge}`;
}

/** A manager prepares the pairing of one device (AUTH-007). */
export const CreatePairingCodeRequest = z
  .strictObject({
    type: DeviceType,
    name: z.string().trim().min(1).max(60),
    /** Required for table tablets: the one table the tablet serves (AUTH-009). */
    tableId: Id.optional(),
    /** For kitchen screens: the station whose tickets it shows (KDS-002). */
    stationId: Id.optional(),
    /**
     * For pagers: the person wearing it. For waiter phones: the person it alerts until someone
     * signs in on it (P2-06a).
     */
    staffId: Id.optional(),
  })
  .refine((request) => request.type !== 'TABLE_TABLET' || request.tableId !== undefined, {
    message: 'A table tablet needs its table',
    path: ['tableId'],
  });
export type CreatePairingCodeRequest = z.infer<typeof CreatePairingCodeRequest>;

/** The local server's address on the LAN, e.g. `https://192.168.1.20:8443` (http in development). */
export const ServerUrl = z.url({ protocol: /^https?$/ }).max(200);

/**
 * What the pairing QR code holds, as JSON (AUTH-007, ADR-0011):
 * `{"v":1,"code":"ABCD-EFGH","ca":"3A:7F:…","urls":["https://192.168.1.20:8443"]}`. `ca` is the
 * fingerprint of the CA the device must pin, absent on a development server without TLS; `urls`
 * are the addresses the server answers on, so nothing needs typing. Fields a device does not know
 * are ignored, so the payload can grow without a new version.
 */
export const PairingQrPayload = z.object({
  v: z.literal(1),
  code: PairingCode,
  ca: CaFingerprint.optional(),
  urls: z.array(ServerUrl).max(8).optional(),
});
export type PairingQrPayload = z.infer<typeof PairingQrPayload>;

/** The pairing details in a scanned QR code, or undefined when it is not a pairing code. */
export function parsePairingQr(text: string): PairingQrPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = PairingQrPayload.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const PairingCodeResponse = z.object({
  code: PairingCode,
  expiresAt: Timestamp,
  /**
   * SHA-256 fingerprint of the installation's LAN CA when the server uses TLS (ADR-0011): the app
   * pins it before connecting. Null on a development server without TLS.
   */
  caSha256: CaFingerprint.nullable(),
  /**
   * Where devices reach the server on the LAN: one address per network address of the server PC
   * (and any configured host name), for pairing without typing and to show next to the code.
   */
  serverUrls: z.array(ServerUrl).max(8),
  /** JSON for the QR code the device scans (`PairingQrPayload`). */
  qrPayload: z.string(),
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

/** The device presents the code with its new public key (SPKI, DER, base64). */
export const PairDeviceRequest = z.strictObject({
  code: PairingCode,
  algorithm: DeviceKeyAlgorithm,
  publicKey: Base64.max(1024),
  /** Signature of `pairingProofMessage(code)`, base64. */
  proof: Base64.max(256),
  appVersion: z.string().max(40).optional(),
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequest>;

export const PairedDevice = z.object({
  deviceId: Id,
  restaurantId: Id,
  type: DeviceType,
  name: z.string(),
  tableId: Id.nullable(),
  stationId: Id.nullable(),
  staffId: Id.nullable(),
});
export type PairedDevice = z.infer<typeof PairedDevice>;

export const DeviceChallengeRequest = z.strictObject({ deviceId: Id });
export type DeviceChallengeRequest = z.infer<typeof DeviceChallengeRequest>;

export const DeviceChallengeResponse = z.object({
  challenge: z.string().min(16),
  expiresAt: Timestamp,
});
export type DeviceChallengeResponse = z.infer<typeof DeviceChallengeResponse>;

export const DeviceTokenRequest = z.strictObject({
  deviceId: Id,
  challenge: z.string().min(16).max(128),
  /** Signature of `deviceTokenMessage(deviceId, challenge)`, base64. */
  signature: Base64.max(256),
});
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>;

export const DeviceTokenResponse = z.object({
  /** Send in the `x-device-token` header of every request until it expires. */
  deviceToken: z.string().min(1),
  expiresAt: Timestamp,
});
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>;

export const DeviceStatus = z.enum(['PENDING', 'ACTIVE', 'REVOKED']);

export const DeviceSummary = z.object({
  id: Id,
  type: DeviceType,
  name: z.string(),
  status: DeviceStatus,
  tableId: Id.nullable(),
  stationId: Id.nullable(),
  staffId: Id.nullable(),
  pairedAt: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
  appVersion: z.string().nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

/** What a manager sees of a device (MGR-006, P4-02c): its summary and its state now. */
export const DeviceView = DeviceSummary.extend({
  /**
   * Connected now: an app or screen with a live connection to the server, or a pager whose
   * heartbeats arrive (PGR-007).
   */
  online: z.boolean(),
  /** The battery level the device last reported (pagers; table tablets from P3-01), if any. */
  batteryPercent: z.int().min(0).max(100).nullable(),
  /**
   * Below the low level of its type: `pager.lowBatteryPercent` for pagers (PGR-013),
   * `devices.lowBatteryAlertPercent` for the others (TAB-015). False while nothing is reported.
   */
  batteryLow: z.boolean(),
  /** A pager's firmware, from its heartbeats. */
  firmwareVersion: z.string().nullable(),
  /** The serial on a pager's label. */
  serial: z.string().nullable(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const DeviceListResponse = z.object({ devices: z.array(DeviceView) });
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;

export const DeviceParams = z.strictObject({ deviceId: Id });
export type DeviceParams = z.infer<typeof DeviceParams>;

/** MGR-006: a manager renames a device, e.g. after moving it. */
export const UpdateDeviceRequest = z.strictObject({ name: z.string().trim().min(1).max(60) });
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;

export const RevokeDeviceRequest = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequest>;

export const BindTableRequest = z.strictObject({ tableId: Id });
export type BindTableRequest = z.infer<typeof BindTableRequest>;
