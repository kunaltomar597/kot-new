import { z } from 'zod';
import { DeviceType, Id, Timestamp } from './common.js';

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
    /** For pagers: the person wearing it. */
    staffId: Id.optional(),
  })
  .refine((request) => request.type !== 'TABLE_TABLET' || request.tableId !== undefined, {
    message: 'A table tablet needs its table',
    path: ['tableId'],
  });
export type CreatePairingCodeRequest = z.infer<typeof CreatePairingCodeRequest>;

export const PairingCodeResponse = z.object({
  code: PairingCode,
  expiresAt: Timestamp,
  /** JSON for the QR code the device scans: `{"v":1,"code":"..."}`. */
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

export const DeviceListResponse = z.object({ devices: z.array(DeviceSummary) });
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;

export const RevokeDeviceRequest = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequest>;

export const BindTableRequest = z.strictObject({ tableId: Id });
export type BindTableRequest = z.infer<typeof BindTableRequest>;
