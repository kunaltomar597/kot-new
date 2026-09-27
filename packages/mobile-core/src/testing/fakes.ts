import type { DeviceKey } from '@rp/api-client';
import type { DeviceSummary, LoginResponse, StaffTile } from '@rp/contracts';
import type { DeviceKeyStore } from '../device-session.js';
import { FakeServer } from './fake-server.js';

type Role = LoginResponse['staff']['role'];

export const DEVICE_ID = '0199a0e0-0000-7000-8000-00000000d001';
export const RESTAURANT_ID = '0199a0e0-0000-7000-8000-00000000a001';
export const STREAM_ID = '0199a0e0-0000-4000-8000-00000000f001';

function tile(staffId: string, displayName: string, role: Role): StaffTile {
  return { staffId, displayName, role, photoId: null };
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
    staff: { id: person.staffId, displayName: person.displayName, role },
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
    });
}

/** A valid `event` frame (an item became ready) for tests of live updates. */
export function itemReadyFrame(sequence: number) {
  const id = '0199a0e0-0000-7000-8000-0000000000f1';
  return {
    sequence,
    event: {
      eventId: id,
      type: 'ItemStatusChanged',
      version: 1,
      occurredAt: '2026-09-26T08:40:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-26',
      payload: {
        orderId: id,
        orderItemId: id,
        from: 'SENT',
        to: 'READY',
        actorId: id,
        deviceId: id,
      },
    },
  };
}
