import { randomUUID } from 'node:crypto';
import type { DomainEvent, RealtimeEndReason, RealtimeSync } from '@rp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectionStatus,
  RealtimeConnection,
  type RealtimeAuthority,
  type RealtimeConnectionOptions,
  type RecoveryDecision,
  type ResumePoint,
} from '../src/index.js';

const STREAM = randomUUID();
const RESTAURANT = randomUUID();

type Listener = (...args: unknown[]) => void;

/** Just enough of a Socket.io client socket to drive the connection. */
class FakeSocket {
  active = false;
  connects = 0;
  disconnects = 0;
  readonly listeners = new Map<string, Listener[]>();
  readonly acks: { event: string; payload: unknown }[] = [];
  ackReply: unknown = undefined;

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

  timeout(): { emitWithAck: (event: string, payload: unknown) => Promise<unknown> } {
    return {
      emitWithAck: (event, payload) => {
        this.acks.push({ event, payload });
        return Promise.resolve(this.ackReply);
      },
    };
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

class FakeAuthority implements RealtimeAuthority {
  decision: RecoveryDecision = 'retry';
  failHandshake = false;
  readonly recovered: string[] = [];
  readonly endings: RealtimeEndReason[] = [];

  handshake(): Promise<{ deviceToken: string; accessToken?: string }> {
    if (this.failHandshake) return Promise.reject(new Error('offline'));
    return Promise.resolve({ deviceToken: 'device-1', accessToken: 'access-1' });
  }

  recover(code: string): Promise<RecoveryDecision> {
    this.recovered.push(code);
    return Promise.resolve(this.decision);
  }

  ended(reason: RealtimeEndReason): void {
    this.endings.push(reason);
  }
}

function event(menuVersion: number, eventId: string = randomUUID()): DomainEvent {
  return {
    eventId,
    type: 'MenuPublished',
    version: 1,
    occurredAt: new Date().toISOString(),
    restaurantId: RESTAURANT,
    businessDate: '2026-09-25',
    payload: { menuVersion },
  };
}

function sync(head: number, fullRefresh = false, streamId = STREAM): RealtimeSync {
  return { streamId, head, replayed: 0, fullRefresh };
}

function setup(options: Partial<RealtimeConnectionOptions> = {}) {
  const authority = new FakeAuthority();
  const received: [string, number][] = [];
  const statuses: ConnectionStatus[] = [];
  const syncs: RealtimeSync[] = [];
  const endings: RealtimeEndReason[] = [];
  const points: ResumePoint[] = [];
  let socket: FakeSocket | undefined;
  const connection = new RealtimeConnection(authority, {
    url: 'http://pos.test',
    retryMs: 1,
    onEvent: (domainEvent, sequence) => received.push([domainEvent.eventId, sequence]),
    onStatus: (status) => statuses.push(status),
    onSync: (value) => syncs.push(value),
    onEnded: (reason) => endings.push(reason),
    onResumePoint: (point) => points.push(point),
    connect: (url, socketOptions) => {
      socket = new FakeSocket(url, socketOptions as FakeSocket['options']);
      return socket as never;
    },
    ...options,
  });
  connection.start();
  if (socket === undefined) throw new Error('No socket');
  return { authority, connection, socket, received, statuses, syncs, endings, points };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('[NFR-P11] [NTF-006] the live connection', () => {
  it('connects to /rt with fresh credentials and the resume point', async () => {
    const resume = { lastSequence: 41, streamId: STREAM };
    const { socket, statuses, connection } = setup({ resume });
    expect(socket.url).toBe('http://pos.test/rt');
    expect(socket.connects).toBe(1);
    expect(statuses).toEqual(['connecting']);
    await expect(socket.handshake()).resolves.toEqual({
      deviceToken: 'device-1',
      accessToken: 'access-1',
      lastSequence: 41,
      streamId: STREAM,
    });
    connection.start();
    expect(socket.connects).toBe(1);
  });

  it('goes online at sync, keeps the resume point and drops duplicate events', () => {
    const { socket, received, statuses, syncs, connection, points } = setup();
    socket.fire('sync', sync(10, true));
    expect(statuses).toEqual(['connecting', 'online']);
    expect(syncs).toHaveLength(1);
    expect(connection.resumePoint).toEqual({ lastSequence: 10, streamId: STREAM });

    const first = event(1);
    socket.fire('event', { sequence: 11, event: first });
    socket.fire('event', { sequence: 11, event: first });
    socket.fire('event', { sequence: 12, event: event(2) });
    socket.fire('event', { sequence: 13, event: { type: 'Nonsense' } });
    expect(received.map(([, sequence]) => sequence)).toEqual([11, 12]);
    expect(connection.resumePoint?.lastSequence).toBe(12);

    socket.fire('head', { streamId: STREAM, head: 20 });
    socket.fire('head', { streamId: randomUUID(), head: 99 });
    socket.fire('head', { nonsense: true });
    expect(connection.resumePoint?.lastSequence).toBe(20);
    socket.fire('sync', sync(15));
    expect(connection.resumePoint?.lastSequence).toBe(20);
    expect(points.at(-1)).toEqual({ lastSequence: 20, streamId: STREAM });
  });

  it('forgets old duplicates after two thousand events', () => {
    const { socket, received } = setup();
    socket.fire('sync', sync(0, true));
    const first = randomUUID();
    socket.fire('event', { sequence: 1, event: event(1, first) });
    for (let index = 2; index <= 2_001; index += 1) {
      socket.fire('event', { sequence: index, event: event(index) });
    }
    socket.fire('event', { sequence: 2_002, event: event(1, first) });
    expect(received).toHaveLength(2_002);
  });

  it('shows offline while Socket.io reconnects by itself after a lost transport', () => {
    const { socket, statuses } = setup();
    socket.fire('sync', sync(1, true));
    socket.fire('disconnect', 'transport close');
    expect(statuses.at(-1)).toBe('offline');
    expect(socket.connects).toBe(1);
    socket.active = true;
    socket.fire('connect_error', new Error('xhr poll error'));
    expect(socket.connects).toBe(1);
  });

  it('reconnects on its own after the session ends, telling the client', () => {
    const { socket, authority, endings } = setup();
    socket.fire('sync', sync(1, true));
    socket.fire('ended', { reason: 'SESSION_ENDED' });
    socket.fire('disconnect', 'io server disconnect');
    expect(authority.endings).toEqual(['SESSION_ENDED']);
    expect(endings).toEqual(['SESSION_ENDED']);
    expect(socket.connects).toBe(2);
  });

  it('stops for good when the device is unpaired', () => {
    const { socket, statuses, connection } = setup();
    socket.fire('ended', { reason: 'DEVICE_REVOKED' });
    socket.fire('disconnect', 'io server disconnect');
    expect(statuses.at(-1)).toBe('stopped');
    expect(connection.status).toBe('stopped');
    expect(socket.connects).toBe(1);
    expect(socket.disconnects).toBe(1);
    socket.fire('disconnect', 'transport close');
    expect(connection.status).toBe('stopped');
  });

  it('starts afresh after the device’s binding changed', async () => {
    const { socket, connection } = setup({ resume: { lastSequence: 5, streamId: STREAM } });
    socket.fire('ended', { reason: 'DEVICE_CHANGED' });
    socket.fire('ended', { reason: 'Nonsense' });
    socket.fire('disconnect', 'io server disconnect');
    expect(connection.resumePoint).toBeUndefined();
    expect(socket.connects).toBe(2);
    expect(await socket.handshake()).not.toHaveProperty('lastSequence');
    // Kicked without a reason: reconnect.
    socket.fire('disconnect', 'io server disconnect');
    expect(socket.connects).toBe(3);
  });

  it('recovers credentials after a refused handshake, then retries with backoff', async () => {
    vi.useFakeTimers();
    const { socket, authority } = setup();
    socket.fire(
      'connect_error',
      Object.assign(new Error('TOKEN_EXPIRED'), { data: { code: 'TOKEN_EXPIRED' } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.recovered).toEqual(['TOKEN_EXPIRED']);
    await vi.advanceTimersByTimeAsync(5);
    expect(socket.connects).toBe(2);

    // A starting server is simply retried, without touching credentials.
    socket.fire(
      'connect_error',
      Object.assign(new Error('x'), { data: { code: 'SERVER_STARTING' } }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(authority.recovered).toEqual(['TOKEN_EXPIRED']);
    expect(socket.connects).toBe(3);
  });

  it('retries when its own handshake failed (offline while renewing)', async () => {
    vi.useFakeTimers();
    const { socket, authority } = setup();
    authority.failHandshake = true;
    await expect(socket.handshake()).resolves.toEqual({});
    socket.fire('connect_error', new Error('HANDSHAKE_INVALID'));
    await vi.advanceTimersByTimeAsync(5);
    expect(authority.recovered).toEqual([]);
    expect(socket.connects).toBe(2);
  });

  it('stops when the refusal cannot be fixed', async () => {
    const { socket, authority, connection } = setup();
    authority.decision = 'stop';
    socket.fire(
      'connect_error',
      Object.assign(new Error('x'), { data: { code: 'DEVICE_NOT_ALLOWED' } }),
    );
    await vi.waitFor(() => {
      expect(connection.status).toBe('stopped');
    });
  });

  it('asks for a resync of what it missed', async () => {
    const { socket, connection, syncs } = setup();
    await expect(connection.resync()).resolves.toBeUndefined();
    socket.fire('sync', sync(3, true));
    socket.ackReply = sync(8);
    await expect(connection.resync()).resolves.toMatchObject({ head: 8 });
    expect(socket.acks).toEqual([
      { event: 'resync', payload: { lastSequence: 3, streamId: STREAM } },
    ]);
    expect(syncs).toHaveLength(2);
    socket.ackReply = { nonsense: true };
    await expect(connection.resync()).resolves.toBeUndefined();
    connection.stop();
    await expect(connection.resync()).resolves.toBeUndefined();
  });

  it('ignores messages after it was stopped', async () => {
    const { socket, connection, received } = setup();
    connection.stop();
    socket.fire('disconnect', 'io server disconnect');
    socket.fire('connect_error', new Error('x'));
    await Promise.resolve();
    expect(connection.status).toBe('stopped');
    expect(received).toEqual([]);
  });
});
