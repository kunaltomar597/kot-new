import { z } from 'zod';
import { Pin } from './auth.js';
import { ClientCompatibility } from './client-api.js';
import { DeviceType, Id, TableState, Timestamp } from './common.js';
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

/** A device's name is what staff call it, like "Kitchen screen 2" (MGR-006). */
export const DeviceName = z.string().trim().min(1).max(60);

/**
 * What a pairing code can pair (AUTH-007): every device but a pager, which is registered on the
 * Pagers page with its own MQTT credential and never gets a device key (PGR-012, SEC-012).
 */
export const PairableDeviceType = DeviceType.exclude(['PAGER']);
export type PairableDeviceType = z.infer<typeof PairableDeviceType>;

/** A manager prepares the pairing of one device (AUTH-007). */
export const CreatePairingCodeRequest = z
  .strictObject({
    type: PairableDeviceType,
    name: DeviceName,
    /** Required for table tablets: the one table the tablet serves (AUTH-009). */
    tableId: Id.optional(),
    /** For kitchen screens: the station whose tickets it shows (KDS-002). */
    stationId: Id.optional(),
    /** For kitchen screens: the stations it shows, when more than one (KDS-002). */
    stationIds: z.array(Id).min(1).max(10).optional(),
    /** For waiter phones: the person it alerts until someone signs in on it (P2-06a). */
    staffId: Id.optional(),
  })
  .refine((request) => request.type !== 'TABLE_TABLET' || request.tableId !== undefined, {
    message: 'A table tablet needs its table',
    path: ['tableId'],
  })
  .refine((request) => request.stationId === undefined || request.stationIds === undefined, {
    message: 'Give the station or the stations, not both',
    path: ['stationIds'],
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

/** How an app is connected (TAB-015). */
export const NETWORK_KINDS = ['WIFI', 'ETHERNET', 'CELLULAR', 'NONE', 'OTHER'] as const;
export const NetworkKind = z.enum(NETWORK_KINDS);
export type NetworkKind = z.infer<typeof NetworkKind>;

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
  /** Every station a kitchen screen shows; empty for all stations (KDS-002). */
  stationIds: z.array(Id).default([]),
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
  /** Every station a kitchen screen shows; empty for all stations (KDS-002). */
  stationIds: z.array(Id).default([]),
  staffId: Id.nullable(),
  pairedAt: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
  appVersion: z.string().nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

/**
 * A device as the manager's device list shows it (MGR-006): its summary plus whether it is
 * connected now, what it last reported and when it was unpaired.
 */
export const DeviceView = DeviceSummary.extend({
  /**
   * Connected now: an app with a live connection to the server, a pager heard from within its
   * last three heartbeats (PGR-007).
   */
  connected: z.boolean(),
  /** Last reported battery: pagers by heartbeat, apps by their health reports (TAB-015). */
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  /** On charge at the last health report; null when the device does not say (pagers). */
  charging: z.boolean().nullable(),
  /** How an app reached the network at its last health report (TAB-015). */
  network: NetworkKind.nullable(),
  /** Wi-Fi signal in dBm at the last heartbeat or health report. */
  rssi: z.int().nullable(),
  /** Pager firmware version (PGR-007). */
  firmwareVersion: z.string().nullable(),
  /** Serial on a pager's label (PGR-012). */
  serial: z.string().nullable(),
  revokedAt: Timestamp.nullable(),
  /** The client API the app last said it speaks (`x-rp-client`), e.g. `1.0` (UPD-006). */
  clientApi: z.string().nullable(),
  /** How that stands against the server's: PREVIOUS and TOO_OLD apps need updating. */
  compatibility: ClientCompatibility,
  /**
   * Until when the device takes no PINs or passwords after too many wrong ones (PC-S5); null when
   * it takes them. A manager can let it take them again sooner (`unlockDevicePins`).
   */
  pinsLockedUntil: Timestamp.nullable(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const DeviceListResponse = z.object({ devices: z.array(DeviceView) });
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;

export const RenameDeviceRequest = z.strictObject({ name: DeviceName });

/** KDS-002: the stations a kitchen screen shows; none for all of them (an Expo/Pass screen). */
export const SetDeviceStationsRequest = z.strictObject({
  stationIds: z.array(Id).max(10),
});
export type SetDeviceStationsRequest = z.infer<typeof SetDeviceStationsRequest>;
export type RenameDeviceRequest = z.infer<typeof RenameDeviceRequest>;

export const RevokeDeviceRequest = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequest>;

/** "Locate" (MGR-006, P3-01c): how long the device shows itself. */
export const LOCATE_SECONDS = 15;

export const LocateDeviceResponse = z.object({ seconds: z.int().positive() });
export type LocateDeviceResponse = z.infer<typeof LocateDeviceResponse>;

export const BindTableRequest = z.strictObject({ tableId: Id });
export type BindTableRequest = z.infer<typeof BindTableRequest>;

// ---------------------------------------------------------------- device health (P3-01a)

/**
 * What an app reports about itself (TAB-015): battery, charging, connection and version. Tablets
 * send it when they start, every few minutes and when something changes; the dashboard shows it
 * and a low battery alerts the managers (`devices.lowBatteryAlertPercent`).
 */
export const DeviceHealthRequest = z.strictObject({
  batteryPercent: z.int().min(0).max(100).nullable(),
  charging: z.boolean().nullable(),
  network: NetworkKind,
  /** Wi-Fi signal in dBm, when on Wi-Fi and the device can tell. */
  rssi: z.int().min(-127).max(0).nullable(),
  appVersion: z.string().trim().min(1).max(40).optional(),
});
export type DeviceHealthRequest = z.infer<typeof DeviceHealthRequest>;

// ---------------------------------------------------------------- the table tablet (P3-01a)

/**
 * A table tablet's own table (TAB-002, TAB-003, AUTH-009): whether a session is open (the tablet
 * unlocks) and what the idle screen shows. A tablet can read only its own table.
 */
export const TabletTableView = z.object({
  tableId: Id,
  /** The table's label, e.g. "T4". */
  label: z.string(),
  state: TableState,
  /** The open session, or null: the tablet shows its idle screen. */
  session: z.object({ id: Id, openedAt: Timestamp, covers: z.int().min(1).nullable() }).nullable(),
  /** The idle screen's promotions (`tablet.idleShowsPromotions`): the restaurant's pinned dishes. */
  promotions: z.object({ show: z.boolean(), itemIds: z.array(Id) }),
  /** Whether menu prices include GST (`billing.priceMode`), for the tax note and estimate (TAB-005). */
  priceMode: z.enum(['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']),
});
export type TabletTableView = z.infer<typeof TabletTableView>;

/**
 * Staff leave the tablet's kiosk mode with a manager's PIN (TAB-001): the hidden gesture shows the
 * managers to choose from; the server checks the PIN (with the usual lock-out) and audits the exit.
 */
export const KioskExitRequest = z.strictObject({ staffId: Id, pin: Pin });
export type KioskExitRequest = z.infer<typeof KioskExitRequest>;

export const KioskExitResponse = z.object({
  approver: z.object({ id: Id, displayName: z.string() }),
  exitedAt: Timestamp,
});
export type KioskExitResponse = z.infer<typeof KioskExitResponse>;
