import { ApiClient } from '@rp/api-client';
import { DomainEvent, type TabletTableView } from '@rp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeviceHealthReading,
  HealthReporter,
  MemoryStore,
  TABLET_GUEST_KEYS,
  TabletSession,
} from '../src/index.js';
import { DEVICE_ID, eventFrame, FakeServer, inMinutes } from '../src/testing/index.js';

const TABLE_ID = '0199a0e0-0000-7000-8000-00000000e001';
const SESSION_A = '0199a0e0-0000-7000-8000-00000000e00a';
const SESSION_B = '0199a0e0-0000-7000-8000-00000000e00b';

const WAITER = '0199a0e0-0000-7000-8000-00000000e0ff';

/** A live event as the client hands it on: checked against its contract. */
function liveEvent(type: string, payload: Record<string, unknown>): DomainEvent {
  return DomainEvent.parse(eventFrame(1, type, payload).event);
}

function clientFor(server: FakeServer): ApiClient {
  return new ApiClient({
    baseUrl: 'http://pos.test:3000',
    fetch: server.fetch,
    credentials: {
      device: {
        deviceId: DEVICE_ID,
        deviceToken: 'device-token-1',
        deviceTokenExpiresAt: inMinutes(60),
      },
    },
  });
}

function table(sessionId: string | null): TabletTableView {
  return {
    tableId: TABLE_ID,
    label: 'T4',
    state: sessionId === null ? 'FREE' : 'OCCUPIED',
    session:
      sessionId === null
        ? null
        : { id: sessionId, openedAt: '2026-10-02T07:00:00.000Z', covers: 2 },
    promotions: { show: true, itemIds: [] },
    priceMode: 'TAX_EXCLUSIVE',
  };
}

async function guestData(store: MemoryStore): Promise<(string | null)[]> {
  return Promise.all(TABLET_GUEST_KEYS.map((key) => store.getItem(key)));
}

async function fillGuestData(store: MemoryStore): Promise<void> {
  for (const key of TABLET_GUEST_KEYS) await store.setItem(key, '{"left":"by guests"}');
}

describe('[TAB-003] the tablet’s table session', () => {
  it('shows the idle screen while the table is free and unlocks when it opens', async () => {
    const server = new FakeServer().on(
      'GET',
      '/api/v1/devices/current/table',
      () => ({ status: 200, body: table(null) }),
      () => ({ status: 200, body: table(SESSION_A) }),
    );
    const client = clientFor(server);
    const tablet = new TabletSession({ store: new MemoryStore(), api: () => client.api });
    expect(tablet.getSnapshot().status).toBe('loading');
    await tablet.refresh();
    expect(tablet.getSnapshot()).toMatchObject({ status: 'ready', table: { session: null } });
    const seen = vi.fn();
    tablet.subscribe(seen);
    tablet.handleEvent(
      liveEvent('TableOpened', {
        tableId: TABLE_ID,
        tableSessionId: SESSION_A,
        covers: 2,
        waiterId: WAITER,
      }),
    );
    await vi.waitFor(() => {
      expect(tablet.getSnapshot().table?.session?.id).toBe(SESSION_A);
    });
    expect(seen).toHaveBeenCalled();
  });

  it('wipes what the guests left when the session closes, and only then', async () => {
    const store = new MemoryStore();
    const server = new FakeServer().on(
      'GET',
      '/api/v1/devices/current/table',
      () => ({ status: 200, body: table(SESSION_A) }),
      () => ({ status: 200, body: table(SESSION_A) }),
      () => ({ status: 200, body: table(null) }),
    );
    const client = clientFor(server);
    const tablet = new TabletSession({ store, api: () => client.api });
    await tablet.refresh();
    const epoch = tablet.getSnapshot().guestEpoch;
    await fillGuestData(store);
    // The same session read again (a reconnect): the guests' cart stays.
    await tablet.refresh();
    expect(await guestData(store)).not.toContain(null);
    expect(tablet.getSnapshot().guestEpoch).toBe(epoch);
    await tablet.refresh();
    expect(await guestData(store)).toEqual(TABLET_GUEST_KEYS.map(() => null));
    expect(tablet.getSnapshot().guestEpoch).toBe(epoch + 1);
  });

  it('also wipes when another session is open by the time the tablet looks (it was off)', async () => {
    const store = new MemoryStore();
    const server = new FakeServer().on(
      'GET',
      '/api/v1/devices/current/table',
      () => ({ status: 200, body: table(SESSION_A) }),
      () => ({ status: 200, body: table(SESSION_B) }),
    );
    const client = clientFor(server);
    const first = new TabletSession({ store, api: () => client.api });
    await first.refresh();
    await fillGuestData(store);
    // The app starts again later, with the same storage.
    const later = new TabletSession({ store, api: () => client.api });
    await later.refresh();
    expect(later.getSnapshot().table?.session?.id).toBe(SESSION_B);
    expect(await guestData(store)).toEqual(TABLET_GUEST_KEYS.map(() => null));
  });

  it('says when no manager has chosen its table, and keeps what it knew when offline', async () => {
    const server = new FakeServer().on(
      'GET',
      '/api/v1/devices/current/table',
      () => ({ status: 200, body: table(null) }),
      () => ({
        status: 503,
        body: { code: 'UNAVAILABLE', message: 'Starting', correlationId: 'x' },
      }),
      () => ({
        status: 409,
        body: { code: 'TABLET_NOT_BOUND', message: 'Not bound', correlationId: 'y' },
      }),
    );
    const client = clientFor(server);
    const errors: unknown[] = [];
    const tablet = new TabletSession({
      store: new MemoryStore(),
      api: () => client.api,
      onError: (error) => errors.push(error),
    });
    await tablet.refresh();
    await tablet.refresh();
    expect(tablet.getSnapshot().status).toBe('ready');
    expect(errors).toHaveLength(1);
    await tablet.refresh();
    expect(tablet.getSnapshot()).toMatchObject({ status: 'unbound', table: undefined });
  });

  it('shows the table as last read after a restart, until the server answers', async () => {
    const store = new MemoryStore();
    const server = new FakeServer().on(
      'GET',
      '/api/v1/devices/current/table',
      () => ({ status: 200, body: table(SESSION_A) }),
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'x', correlationId: 'x' } }),
    );
    const client = clientFor(server);
    await new TabletSession({ store, api: () => client.api }).refresh();
    const restarted = new TabletSession({ store, api: () => client.api });
    await restarted.restore();
    expect(restarted.getSnapshot()).toMatchObject({
      status: 'ready',
      table: { session: { id: SESSION_A } },
    });
    await restarted.refresh();
    expect(restarted.getSnapshot().table?.session?.id).toBe(SESSION_A);
  });

  it('reads once more, not many times, when events arrive while it reads', async () => {
    const server = new FakeServer().on('GET', '/api/v1/devices/current/table', () => ({
      status: 200,
      body: table(null),
    }));
    const client = clientFor(server);
    const tablet = new TabletSession({ store: new MemoryStore(), api: () => client.api });
    const reading = tablet.refresh();
    for (let n = 0; n < 5; n += 1) {
      tablet.handleEvent(liveEvent('TableStateChanged', { tableId: TABLE_ID, state: 'FREE' }));
    }
    tablet.handleEvent(liveEvent('MenuPublished', { menuVersion: 2 }));
    await reading;
    await vi.waitFor(() => {
      expect(server.callsTo('GET', '/api/v1/devices/current/table')).toHaveLength(2);
    });
  });
});

describe('[TAB-015] health reports', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function reporterFor(server: FakeServer, readings: DeviceHealthReading[], now: () => number) {
    const client = clientFor(server);
    let index = 0;
    return new HealthReporter({
      source: {
        readHealth: () => readings[Math.min(index++, readings.length - 1)] ?? readings[0]!,
      },
      api: () => client.api,
      appVersion: '0.2.0',
      now,
    });
  }

  const reading = (batteryPercent: number, charging = false): DeviceHealthReading => ({
    batteryPercent,
    charging,
    network: 'WIFI',
    rssi: -55,
  });

  it('reports at once, then only on a change worth telling or after a quiet while', async () => {
    const server = new FakeServer().on('POST', '/api/v1/devices/current/health', () => ({
      status: 204,
    }));
    let now = 0;
    const reporter = reporterFor(
      server,
      [reading(80), reading(78), reading(74), reading(74, true), reading(74, true)],
      () => now,
    );
    const sent = () => server.callsTo('POST', '/api/v1/devices/current/health');
    await reporter.tick();
    expect(sent()[0]?.body).toEqual({ ...reading(80), appVersion: '0.2.0' });
    now = 60_000;
    await reporter.tick(); // 78: within the step
    now = 120_000;
    await reporter.tick(); // 74: a step from 80
    now = 180_000;
    await reporter.tick(); // put on charge
    now = 240_000;
    await reporter.tick(); // nothing new
    expect(sent().map((call) => (call.body as DeviceHealthReading).batteryPercent)).toEqual([
      80, 74, 74,
    ]);
    now = 480_000;
    await reporter.tick(); // five quiet minutes since the last report
    expect(sent()).toHaveLength(4);
  });

  it('tries again at the next look when a report fails', async () => {
    const server = new FakeServer().on(
      'POST',
      '/api/v1/devices/current/health',
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'x', correlationId: 'x' } }),
      () => ({ status: 204 }),
    );
    const reporter = reporterFor(server, [reading(50)], () => 0);
    await reporter.tick();
    await reporter.tick();
    expect(server.callsTo('POST', '/api/v1/devices/current/health')).toHaveLength(2);
    await reporter.tick();
    expect(server.callsTo('POST', '/api/v1/devices/current/health')).toHaveLength(2);
  });
});
