import type { RelaySessionResponse } from '@rp/contracts/relay';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayError } from '../../src/relay/relay-client.js';
import { RelayRealtime, type RelayRealtimeOptions } from '../../src/relay/relay-realtime.js';
import { until } from '../helpers/wait.js';

/** A scripted WebSocket: records what is sent; the test plays Realtime's part. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: { topic: string; event: string; payload: Record<string, unknown>; ref: string }[] =
    [];
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => {
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as FakeSocket['sent'][number]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => {
      this.emit('close', {});
    }, 0);
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Realtime answers. */
  receive(message: object): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  sentEvents(event: string) {
    return this.sent.filter((message) => message.event === event);
  }

  /** Accepts the join, granting `granted` (all asked for by default). */
  acceptJoin(granted?: unknown[]): void {
    const join = this.sentEvents('phx_join')[0];
    if (join === undefined) throw new Error('No join yet');
    const config = join.payload.config as { postgres_changes: object[] };
    this.receive({
      topic: join.topic,
      event: 'phx_reply',
      payload: {
        status: 'ok',
        response: {
          postgres_changes:
            granted ?? config.postgres_changes.map((change, index) => ({ ...change, id: index })),
        },
      },
      ref: join.ref,
    });
  }
}

const TENANT = '0199a0e0-0000-7000-8000-000000000001';
const session = (expiresInMs = 3_600_000): RelaySessionResponse => ({
  tenantId: TENANT,
  token: `token-${String(Date.now())}`,
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  realtime: {
    apiKey: 'publishable',
    changes: [
      { event: 'INSERT', schema: 'relay', table: 'qr_orders', filter: `tenant_id=eq.${TENANT}` },
    ],
  },
});

let doorbell: RelayRealtime | undefined;

function start(overrides: Partial<RelayRealtimeOptions> = {}) {
  FakeSocket.all = [];
  const rings: number[] = [];
  const changes: boolean[] = [];
  const sessions: number[] = [];
  doorbell = new RelayRealtime({
    relayUrl: 'https://abc.supabase.co/functions/v1',
    session: () => {
      sessions.push(Date.now());
      return Promise.resolve(session());
    },
    onRing: () => rings.push(Date.now()),
    onChange: (subscribed) => changes.push(subscribed),
    heartbeatMs: 30,
    refreshBeforeMs: 60_000,
    retryBaseMs: 10,
    retryMaxMs: 40,
    notConfiguredRetryMs: 3_600_000,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    ...overrides,
  });
  doorbell.start(0);
  return { rings, changes, sessions };
}

const socket = (index: number) =>
  until(() => FakeSocket.all[index], 1_000, `socket ${String(index)}`);

afterEach(() => {
  doorbell?.stop();
});

describe('[QR-009] the Realtime doorbell', () => {
  it('joins with the session’s token and rings on a new order, and on joining', async () => {
    const { rings, changes } = start();
    const first = await socket(0);
    expect(first.url).toBe(
      'wss://abc.supabase.co/realtime/v1/websocket?apikey=publishable&vsn=1.0.0',
    );
    await until(() => first.sentEvents('phx_join').length === 1, 1_000, 'the join');
    const join = first.sentEvents('phx_join')[0];
    expect(join?.payload).toMatchObject({
      access_token: expect.stringMatching(/^token-/) as unknown,
      config: { postgres_changes: session().realtime.changes, private: false },
    });
    first.acceptJoin();
    expect(doorbell?.subscribed).toBe(true);
    expect(changes).toEqual([true]);
    expect(rings).toHaveLength(1);
    first.receive({
      topic: join?.topic,
      event: 'postgres_changes',
      payload: { ids: [0], data: { type: 'INSERT' } },
    });
    expect(rings).toHaveLength(2);
  });

  it('does not count on a join that left out a change it asked for', async () => {
    const { changes } = start();
    const first = await socket(0);
    await until(() => first.sentEvents('phx_join').length === 1, 1_000, 'the join');
    first.acceptJoin([]);
    expect(doorbell?.subscribed).toBe(false);
    expect(changes).toEqual([]);
    expect(first.closed).toBe(true);
    // And tries again.
    await socket(1);
  });

  it('gives up on a line whose heartbeat goes unanswered, and joins again', async () => {
    const { changes } = start();
    const first = await socket(0);
    await until(() => first.sentEvents('phx_join').length === 1, 1_000, 'the join');
    first.acceptJoin();
    // Realtime goes silent: no heartbeat is answered.
    await until(() => first.closed, 1_000, 'the silent line to be dropped');
    expect(first.sentEvents('heartbeat').length).toBeGreaterThanOrEqual(1);
    expect(changes).toEqual([true, false]);
    const second = await socket(1);
    await until(() => second.sentEvents('phx_join').length === 1, 1_000, 'a new join');
  });

  it('keeps a line whose heartbeats are answered', async () => {
    start();
    const first = await socket(0);
    await until(() => first.sentEvents('phx_join').length === 1, 1_000, 'the join');
    first.acceptJoin();
    for (let beat = 1; beat <= 3; beat += 1) {
      await until(() => first.sentEvents('heartbeat').length === beat, 1_000, 'a heartbeat');
      const heartbeat = first.sentEvents('heartbeat')[beat - 1];
      expect(heartbeat?.topic).toBe('phoenix');
      first.receive({
        topic: 'phoenix',
        event: 'phx_reply',
        payload: { status: 'ok', response: {} },
        ref: heartbeat?.ref,
      });
    }
    expect(first.closed).toBe(false);
    expect(doorbell?.subscribed).toBe(true);
  });

  it('joins again when Realtime closes the channel (a token run out)', async () => {
    start();
    const first = await socket(0);
    await until(() => first.sentEvents('phx_join').length === 1, 1_000, 'the join');
    first.acceptJoin();
    first.receive({
      topic: first.sentEvents('phx_join')[0]?.topic,
      event: 'system',
      payload: { status: 'error', message: 'Token has expired' },
    });
    expect(first.closed).toBe(true);
    expect(doorbell?.subscribed).toBe(false);
    await socket(1);
  });

  it('renews the token on the same channel before it runs out', async () => {
    // (Heartbeats are left unanswered here, so they are slowed down.)
    const { sessions } = start({ refreshBeforeMs: 3_600_000 - 1_000, heartbeatMs: 60_000 });
    const first = await socket(0);
    await until(() => first.sentEvents('phx_join').length === 1, 1_000, 'the join');
    first.acceptJoin();
    await until(() => first.sentEvents('access_token').length === 1, 3_000, 'a renewed token');
    expect(sessions).toHaveLength(2);
    expect(first.closed).toBe(false);
  });

  it('[NFR-A01] stays off without Realtime at the relay, and asks again much later', async () => {
    let asked = 0;
    const { changes } = start({
      session: () => {
        asked += 1;
        return Promise.reject(new RelayError('REALTIME_NOT_CONFIGURED', 'No Realtime', 503));
      },
    });
    await until(() => asked === 1, 1_000, 'the session request');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toBe(1);
    expect(FakeSocket.all).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('backs off while the relay cannot be reached', async () => {
    let asked = 0;
    start({
      session: () => {
        asked += 1;
        return Promise.reject(new RelayError('UNREACHABLE', 'Down'));
      },
    });
    await until(() => asked >= 3, 1_000, 'retries');
    expect(FakeSocket.all).toEqual([]);
  });
});
