import { z } from 'zod';
import { DomainEvent } from './events.js';

/**
 * Live updates from the local server to apps (BRD §10.4): Socket.io on the server's own port
 * (TLS from P0-15), namespace `/rt`, WebSocket transport only. Commands and queries stay on REST; the socket only
 * carries domain events to the rooms allowed to see them (ORD-010, SEC-003).
 *
 * Protocol:
 *
 * 1. Connect with `auth` = `RealtimeHandshake`. A paired device's token is required; a signed-in
 *    person's access token is optional and, if present, must be valid (else `connect_error`).
 * 2. When `lastSequence` (and the `streamId` it came from) is sent, the server first replays the
 *    events after it that this connection may see, as ordinary `event` messages, then sends `sync`.
 *    `sync.fullRefresh` means the gap could not be replayed (first connection, too old, different
 *    stream after a restore): reload state over REST.
 * 3. Then `event` messages arrive live, in sequence order. Every event is delivered at least once;
 *    de-duplicate by `event.eventId` (NTF-006). Sequences are global, so gaps between the events one
 *    connection sees are normal.
 * 4. `head` arrives periodically: everything up to `head` that this connection may see has been
 *    sent. Keep the highest sequence seen (from `event`, `sync` or `head`) and send it on reconnect
 *    (NFR-P11).
 * 5. `ended` precedes a disconnect by the server (device unpaired, session ended). Reconnect with
 *    the credentials the device has now.
 */
export const REALTIME_NAMESPACE = '/rt';
export const REALTIME_PATH = '/socket.io';

/** Message names on the `/rt` namespace. */
export const REALTIME_MESSAGES = {
  /** Server → client: `RealtimeEvent`. */
  event: 'event',
  /** Server → client, once per connection after any replay: `RealtimeSync`. */
  sync: 'sync',
  /** Server → client, periodically: `RealtimeHead`. */
  head: 'head',
  /** Client → server with an acknowledgement: `RealtimeResyncRequest` → `RealtimeSync`. */
  resync: 'resync',
  /** Server → client before it disconnects the connection: `RealtimeEnded`. */
  ended: 'ended',
} as const;

const Sequence = z.int().nonnegative();
const Token = z.string().min(1).max(4096);

export const RealtimeHandshake = z.object({
  /** The device token from `POST /api/v1/devices/token` (AUTH-007). */
  deviceToken: Token,
  /** The signed-in person's access token, if someone is signed in on the device. */
  accessToken: Token.optional(),
  /** The highest sequence this device has seen, to resume from. */
  lastSequence: Sequence.optional(),
  /** The stream `lastSequence` belongs to. */
  streamId: z.uuid().optional(),
});
export type RealtimeHandshake = z.infer<typeof RealtimeHandshake>;

export const RealtimeEvent = z.object({
  sequence: z.int().positive(),
  event: DomainEvent,
});
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

export const RealtimeSync = z.object({
  /** Identifies this server's event history; changes when the database is restored. */
  streamId: z.uuid(),
  /** Everything up to this sequence that the connection may see has now been sent. */
  head: Sequence,
  /** How many events were replayed before this message. */
  replayed: z.int().nonnegative(),
  /** True when missed events could not be replayed: reload state over REST. */
  fullRefresh: z.boolean(),
});
export type RealtimeSync = z.infer<typeof RealtimeSync>;

export const RealtimeHead = z.object({ streamId: z.uuid(), head: Sequence });
export type RealtimeHead = z.infer<typeof RealtimeHead>;

export const RealtimeResyncRequest = z.object({
  lastSequence: Sequence,
  streamId: z.uuid().optional(),
});
export type RealtimeResyncRequest = z.infer<typeof RealtimeResyncRequest>;

export const RealtimeEndReason = z.enum([
  /** The device was unpaired (AUTH-008). */
  'DEVICE_REVOKED',
  /** The device's binding (table, station, person) changed: reconnect to get the new rooms. */
  'DEVICE_CHANGED',
  /** The person's session ended (sign-out, inactivity, revoked) or their role changed. */
  'SESSION_ENDED',
]);
export type RealtimeEndReason = z.infer<typeof RealtimeEndReason>;

export const RealtimeEnded = z.object({ reason: RealtimeEndReason });
export type RealtimeEnded = z.infer<typeof RealtimeEnded>;

/**
 * `connect_error` codes (the error's `message`; `data` carries `{ code, message }`). Besides these,
 * an invalid access token is refused with the REST error code (`TOKEN_EXPIRED`, `SESSION_EXPIRED`,
 * `SESSION_REVOKED`, `TOKEN_INVALID`, `DEVICE_MISMATCH`).
 */
export const REALTIME_CONNECT_ERRORS = {
  /** The handshake `auth` payload is missing or malformed. */
  handshakeInvalid: 'HANDSHAKE_INVALID',
  /** No valid device token, or the device is not paired (any more). */
  deviceNotRecognised: 'DEVICE_NOT_RECOGNISED',
  /** This kind of device does not use the socket (pagers use MQTT). */
  deviceNotAllowed: 'DEVICE_NOT_ALLOWED',
  /** The server is starting and cannot serve live updates yet (database not reachable); retry. */
  starting: 'SERVER_STARTING',
  /** The server could not check the connection (for example, the database is busy); retry. */
  internalError: 'INTERNAL_ERROR',
} as const;
