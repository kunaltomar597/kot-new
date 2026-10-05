import type { DeviceKey } from '@rp/api-client';
import type { AlertView, DeviceSummary, LoginResponse, StaffTile } from '@rp/contracts';
import type { AlertHolder, AlertNotifier } from '../alert-center.js';
import type { DeviceKeyStore } from '../device-session.js';
import type { ServerAuthority, ServerTrust } from '../server-trust.js';
import { FakeServer } from './fake-server.js';

type Role = LoginResponse['staff']['role'];

export const DEVICE_ID = '0199a0e0-0000-7000-8000-00000000d001';
export const RESTAURANT_ID = '0199a0e0-0000-7000-8000-00000000a001';
export const STREAM_ID = '0199a0e0-0000-4000-8000-00000000f001';

function tile(staffId: string, displayName: string, role: Role): StaffTile {
  return { staffId, displayName, role, customRoleName: null, photoId: null };
}

export const STAFF: Readonly<Record<Role, StaffTile>> = {
  OWNER: tile('0199a0e0-0000-7000-8000-000000000101', 'Kunal', 'OWNER'),
  MANAGER: tile('0199a0e0-0000-7000-8000-000000000102', 'Meera', 'MANAGER'),
  CASHIER: tile('0199a0e0-0000-7000-8000-000000000103', 'Asha', 'CASHIER'),
  WAITER: tile('0199a0e0-0000-7000-8000-000000000104', 'Ravi', 'WAITER'),
  KITCHEN: tile('0199a0e0-0000-7000-8000-000000000105', 'Imran', 'KITCHEN'),
};

export function deviceSummary(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: DEVICE_ID,
    type: 'POS',
    name: 'Counter POS',
    status: 'ACTIVE',
    tableId: null,
    stationId: null,
    staffId: null,
    pairedAt: '2026-09-25T10:00:00.000Z',
    lastSeenAt: null,
    appVersion: null,
    ...overrides,
  };
}

export function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function login(role: Role, inactivityTimeoutSeconds = 600): LoginResponse {
  const person = STAFF[role];
  return {
    accessToken: `access-${role}`,
    accessTokenExpiresAt: inMinutes(15),
    refreshToken: `refresh-token-for-${role.toLowerCase()}-0001`,
    session: {
      id: '0199a0e0-0000-7000-8000-00000000e001',
      expiresAt: inMinutes(600),
      inactivityTimeoutSeconds,
    },
    staff: { id: person.staffId, displayName: person.displayName, role, customRole: null },
    secondFactorValidUntil: null,
  };
}

type Listener = (...args: unknown[]) => void;

/** A stand-in for a Socket.io client socket: the test fires server messages at it. */
export class FakeSocket {
  active = false;
  connects = 0;
  disconnects = 0;
  readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly options: { auth: (reply: (auth: Record<string, unknown>) => void) => void },
  ) {}

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  connect(): this {
    this.connects += 1;
    return this;
  }

  disconnect(): this {
    this.disconnects += 1;
    return this;
  }

  timeout(): { emitWithAck: () => Promise<unknown> } {
    return { emitWithAck: () => Promise.resolve(undefined) };
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  handshake(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.options.auth(resolve);
    });
  }
}

/** Records every socket the console opens; the last one is the live connection. */
export class SocketFactory {
  readonly sockets: FakeSocket[] = [];

  readonly connect = (url: string, options: unknown): never => {
    const socket = new FakeSocket(url, options as FakeSocket['options']);
    this.sockets.push(socket);
    return socket as never;
  };

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('No socket was opened');
    return socket;
  }

  /** The server accepts the connection and says it is in sync. */
  sync(head = 0): void {
    this.last.fire('sync', { streamId: STREAM_ID, head, replayed: 0, fullRefresh: true });
  }
}

/** The Keystore stand-in: counts keys created; signatures are not checked by the fake server. */
export class FakeKeys implements DeviceKeyStore {
  key: DeviceKey | undefined;
  created = 0;

  load(): Promise<DeviceKey | undefined> {
    return Promise.resolve(this.key);
  }

  create(): Promise<DeviceKey> {
    this.created += 1;
    this.key = {
      algorithm: 'ES256',
      publicKey: `AAAA${String(this.created)}`,
      sign: () => Promise.resolve('c2lnbmF0dXJl'),
    };
    return Promise.resolve(this.key);
  }

  remove(): Promise<void> {
    this.key = undefined;
    return Promise.resolve();
  }
}

function sampleFingerprint(first: number): string {
  return Array.from({ length: 32 }, (_, index) =>
    ((first + index) % 256).toString(16).toUpperCase().padStart(2, '0'),
  ).join(':');
}

/** The restaurant's LAN CA as its server hands it out (ADR-0011); the PEM is only a sample. */
export const LAN_CA: ServerAuthority = {
  certificate: '-----BEGIN CERTIFICATE-----\nTEFOIENB\n-----END CERTIFICATE-----\n',
  sha256: sampleFingerprint(0x3a),
};

/** Somebody else's CA: a stranger on the network standing in for the server. */
export const OTHER_CA: ServerAuthority = {
  certificate: '-----BEGIN CERTIFICATE-----\nT1RIRVIgQ0E=\n-----END CERTIFICATE-----\n',
  sha256: sampleFingerprint(0x7f),
};

/**
 * The Android trust module's stand-in (ADR-0011): the servers that hand out a CA before pairing and
 * what the device pinned. `pin` answers the certificate's sample fingerprint, or `pinAnswer`.
 */
export class FakeTrust implements ServerTrust {
  /** Addresses whose CA was asked for, in order. */
  readonly fetched: string[] = [];
  pinned: { readonly certificate: string; readonly serverUrl: string } | undefined;
  clears = 0;
  /** What `pin` answers instead of the certificate's fingerprint: a device that disagrees. */
  pinAnswer: string | undefined;
  private readonly servers = new Map<string, ServerAuthority>();

  /** A server at `serverUrl` hands out `authority`; nothing answers at any other address. */
  serve(serverUrl: string, authority: ServerAuthority = LAN_CA): this {
    this.servers.set(serverUrl, authority);
    return this;
  }

  fetchAuthority(serverUrl: string): Promise<ServerAuthority> {
    this.fetched.push(serverUrl);
    const authority = this.servers.get(serverUrl);
    return authority === undefined
      ? Promise.reject(new Error(`Nothing answered at ${serverUrl}`))
      : Promise.resolve(authority);
  }

  pin(certificate: string, serverUrl: string): Promise<string> {
    this.pinned = { certificate, serverUrl };
    const known = [LAN_CA, OTHER_CA, ...this.servers.values()].find(
      (authority) => authority.certificate === certificate,
    );
    return Promise.resolve(this.pinAnswer ?? known?.sha256 ?? 'not a certificate');
  }

  clear(): Promise<void> {
    this.clears += 1;
    this.pinned = undefined;
    return Promise.resolve();
  }
}

/** An open alert of the waiter's, as the server lists it (P2-06a): food ready at table 5. */
export function alertView(overrides: Partial<AlertView> = {}): AlertView {
  return {
    id: '0199a0e0-0000-7000-8000-0000000a1e01',
    type: 'ITEM_READY',
    status: 'OPEN',
    tableId: '0199a0e0-0000-7000-8000-00000000b005',
    tableLabel: '5',
    tableSessionId: '0199a0e0-0000-7000-8000-00000000c005',
    orderId: null,
    pagerText: 'T5 READY',
    payload: { items: ['Paneer Tikka'] },
    raisedByName: null,
    recipientIds: [STAFF.WAITER.staffId],
    channels: ['PAGER', 'WAITER_APP', 'TABLET'],
    repeatCount: 0,
    escalatedAt: null,
    escalatedTo: [],
    createdAt: '2026-09-26T08:40:00.000Z',
    acknowledgedAt: null,
    acknowledgedById: null,
    clearedAt: null,
    ...overrides,
  };
}

/** The phone's holder in tests: the waiter. */
export const HOLDER: AlertHolder = {
  staffId: STAFF.WAITER.staffId,
  displayName: STAFF.WAITER.displayName,
};

/**
 * The Android notifier's stand-in (P2-06b): what rang, what was taken off, and whether it listens.
 * `pressAcknowledge` is a person pressing Acknowledge on a notification.
 */
export class FakeNotifier implements AlertNotifier {
  readonly announced: AlertView[] = [];
  readonly dismissed: string[] = [];
  /** Whom it listens for; null when stopped. */
  holder: AlertHolder | null = null;
  starts = 0;
  stops = 0;
  private readonly listeners = new Set<(alertId: string) => void>();

  start(holder: AlertHolder): Promise<void> {
    this.holder = holder;
    this.starts += 1;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.holder = null;
    this.stops += 1;
    return Promise.resolve();
  }

  announce(alert: AlertView): Promise<void> {
    this.announced.push(alert);
    return Promise.resolve();
  }

  dismiss(alertId: string): Promise<void> {
    this.dismissed.push(alertId);
    return Promise.resolve();
  }

  onAcknowledge(listener: (alertId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pressAcknowledge(alertId: string): void {
    for (const listener of this.listeners) listener(alertId);
  }
}

/** A local server that pairs a device of `type`, lists staff and signs a waiter in. */
export function fakeLocalServer(
  device: Partial<DeviceSummary> = { type: 'WAITER_PHONE', name: 'Waiter phone 1' },
): FakeServer {
  const summary = deviceSummary(device);
  return new FakeServer()
    .on('POST', '/api/v1/devices/pair', () => ({
      status: 201,
      body: {
        deviceId: DEVICE_ID,
        restaurantId: RESTAURANT_ID,
        type: summary.type,
        name: summary.name,
        tableId: summary.tableId,
        stationId: null,
        staffId: null,
      },
    }))
    .on('POST', '/api/v1/devices/challenge', () => ({
      status: 200,
      body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
    }))
    .on('POST', '/api/v1/devices/token', () => ({
      status: 200,
      body: { deviceToken: 'device-token-1', expiresAt: inMinutes(60) },
    }))
    .on('GET', '/api/v1/devices/current', () => ({ status: 200, body: summary }))
    .on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 200,
      body: { staff: Object.values(STAFF) },
    }))
    .on('POST', '/api/v1/auth/pin-login', () => ({ status: 200, body: login('WAITER') }))
    .on('POST', '/api/v1/auth/logout', () => ({ status: 204 }))
    .on('GET', '/api/v1/auth/session', () => {
      const { session, staff, secondFactorValidUntil } = login('WAITER');
      return { status: 200, body: { session, staff, secondFactorValidUntil } };
    })
    .on('GET', '/api/v1/devices/current/alerts', () => ({
      status: 200,
      body: { holder: null, alerts: [] },
    }));
}

/** A valid `event` frame for tests of live updates; its payload must match the event's contract. */
export function eventFrame(sequence: number, type: string, payload: Record<string, unknown>) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
      type,
      version: 1,
      occurredAt: '2026-09-26T08:40:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-26',
      payload,
    },
  };
}

/** An `AlertRaised` frame for `alert` (its first delivery, or the repeat given). */
export function alertRaisedFrame(sequence: number, alert: AlertView, repeat = alert.repeatCount) {
  return eventFrame(sequence, 'AlertRaised', {
    alertId: alert.id,
    eventType: alert.type,
    recipients: alert.recipientIds,
    pagerText: alert.pagerText,
    tableId: alert.tableId,
    repeat,
    escalated: alert.escalatedAt !== null,
  });
}

/** A valid `event` frame (an item became ready) for tests of live updates. */
export function itemReadyFrame(sequence: number) {
  const id = '0199a0e0-0000-7000-8000-0000000000f1';
  return eventFrame(sequence, 'ItemStatusChanged', {
    orderId: id,
    orderItemId: id,
    from: 'SENT',
    to: 'READY',
    actorId: id,
    deviceId: id,
  });
}
