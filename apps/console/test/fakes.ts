import type { DeviceSummary, LoginResponse, StaffTile } from '@rp/contracts';
import type { Role } from '@rp/domain';

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

/** A real (non-extractable) key pair; the fake server does not check signatures. */
export async function fakeKey() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  return {
    keyPair,
    key: {
      algorithm: 'ES256' as const,
      publicKey: 'AAAA',
      sign: () => Promise.resolve('c2lnbmF0dXJl'),
    },
  };
}
