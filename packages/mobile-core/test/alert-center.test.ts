import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@rp/api-client';
import type { AlertView, DeviceAlertsResponse } from '@rp/contracts';
import { DeviceSession, MemoryStore } from '../src/index.js';
import {
  alertRaisedFrame,
  alertView,
  eventFrame,
  FakeKeys,
  FakeNotifier,
  type FakeServer,
  fakeLocalServer,
  HOLDER,
  SocketFactory,
  STAFF,
} from '../src/testing/index.js';

const ADDRESS = 'http://pos.test:3000';
const ALERTS = '/api/v1/devices/current/alerts';

const ready = alertView();
const bill = alertView({
  id: '0199a0e0-0000-7000-8000-0000000a1e02',
  type: 'BILL_REQUEST',
  tableLabel: '7',
  pagerText: 'T7 BILL',
  payload: {},
  channels: ['PAGER', 'WAITER_APP', 'POS'],
});
const meeras = alertView({
  id: '0199a0e0-0000-7000-8000-0000000a1e03',
  recipientIds: [STAFF.MANAGER.staffId],
});

/** A server whose answers to the phone's alert list are `lists`, in turn (the last one stays). */
function serverListing(...lists: DeviceAlertsResponse[]): FakeServer {
  return fakeLocalServer().on('GET', ALERTS, ...lists.map((body) => () => ({ status: 200, body })));
}

const held = (...alerts: AlertView[]): DeviceAlertsResponse => ({ holder: HOLDER, alerts });

async function phone(fake: FakeServer, options: { followAlerts?: boolean } = {}) {
  const sockets = new SocketFactory();
  const notifier = new FakeNotifier();
  const errors: unknown[] = [];
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore: new MemoryStore(),
    keys: new FakeKeys(),
    fetch: fake.fetch,
    connect: sockets.connect,
    followAlerts: options.followAlerts ?? true,
    alertNotifier: notifier,
    onError: (error) => errors.push(error),
  });
  await session.start();
  await session.pair(ADDRESS, 'abcd-efgh');
  return { session, sockets, notifier, errors };
}

const reads = (fake: FakeServer) => fake.callsTo('GET', ALERTS).length;

/** Lets every promise already on its way settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('[WTR-006] [NTF-006] the alerts of the person the phone alerts', () => {
  it('reads them when the phone connects and again after every reconnect', async () => {
    const fake = serverListing(held(ready));
    const { session, sockets, notifier } = await phone(fake);
    expect(reads(fake)).toBe(0);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().status).toBe('ready');
    expect(session.alerts.getSnapshot()).toEqual({
      status: 'ready',
      holder: HOLDER,
      alerts: [ready],
    });
    expect(notifier.holder).toEqual(HOLDER);
    expect(notifier.announced).toEqual([ready]);

    // Wi-Fi drops and comes back: what was missed is read again, without ringing twice.
    sockets.last.fire('disconnect', 'transport close');
    sockets.sync(4);
    await expect.poll(() => reads(fake)).toBe(2);
    await expect.poll(() => session.alerts.getSnapshot().alerts).toEqual([ready]);
    expect(notifier.announced).toEqual([ready]);
    expect(notifier.starts).toBe(1);
  });

  it('rings once for each repeat, at once from the event', async () => {
    const again = { ...ready, repeatCount: 1 };
    const fake = serverListing(held(ready), held(again));
    const { session, sockets, notifier } = await phone(fake);
    sockets.sync();
    await expect.poll(() => notifier.announced.length).toBe(1);

    sockets.last.fire('event', alertRaisedFrame(5, ready, 1));
    expect(notifier.announced.at(-1)).toEqual(again);
    expect(session.alerts.getSnapshot().alerts).toEqual([again]);
    // The read after the event brings the same repeat: it does not ring again.
    await expect.poll(() => reads(fake)).toBe(2);
    await settled();
    expect(notifier.announced).toEqual([ready, again]);
  });

  it('reads a new alert for the holder, and ignores alerts for other people', async () => {
    const fake = serverListing(held(ready), held(ready, bill));
    const { session, sockets, notifier } = await phone(fake);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().status).toBe('ready');

    // A manager hears every alert of the restaurant: one for someone else is not read.
    sockets.last.fire('event', alertRaisedFrame(5, meeras));
    await settled();
    expect(reads(fake)).toBe(1);

    sockets.last.fire('event', alertRaisedFrame(6, bill));
    await expect.poll(() => session.alerts.getSnapshot().alerts).toEqual([ready, bill]);
    expect(notifier.announced).toEqual([ready, bill]);
  });

  it('coalesces the reads asked for while one is on its way', async () => {
    const fake = serverListing(held(ready));
    const { session, sockets } = await phone(fake);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().status).toBe('ready');
    await settled();
    const before = reads(fake);
    await Promise.all([
      session.alerts.refresh(),
      session.alerts.refresh(),
      session.alerts.refresh(),
    ]);
    // One on its way and one more after it, however many asked.
    expect(reads(fake) - before).toBe(2);
  });

  it('stops listening when nobody holds the phone, and starts for the next person', async () => {
    const asha = { staffId: STAFF.CASHIER.staffId, displayName: STAFF.CASHIER.displayName };
    const hers = { ...bill, recipientIds: [asha.staffId] };
    const fake = serverListing(
      held(ready),
      { holder: null, alerts: [] },
      { holder: asha, alerts: [hers] },
    );
    const { session, sockets, notifier } = await phone(fake);
    sockets.sync();
    await expect.poll(() => notifier.holder).toEqual(HOLDER);

    // The waiter signed out on the phone: it reconnects and alerts nobody.
    await session.alerts.refresh();
    expect(session.alerts.getSnapshot()).toMatchObject({ holder: null, alerts: [] });
    expect(notifier.holder).toBeNull();
    expect(notifier.dismissed).toEqual([ready.id]);
    // Nobody's alerts are read on a phone nobody holds.
    sockets.last.fire('event', alertRaisedFrame(5, bill));
    await settled();
    expect(reads(fake)).toBe(2);

    await session.alerts.refresh();
    expect(notifier.holder).toEqual(asha);
    expect(notifier.announced.at(-1)).toEqual(hers);
  });

  it('follows nothing on a device that does not ask to (the table tablet)', async () => {
    const fake = serverListing(held(ready));
    const { session, sockets } = await phone(fake, { followAlerts: false });
    sockets.sync();
    sockets.last.fire('event', alertRaisedFrame(5, ready));
    await settled();
    expect(reads(fake)).toBe(0);
    expect(session.alerts.getSnapshot().status).toBe('idle');
  });

  it('says so when the first read fails, and keeps the list when a later one does', async () => {
    const fake = fakeLocalServer().on(
      'GET',
      ALERTS,
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'Starting.' } }),
      () => ({ status: 200, body: held(ready) }),
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'Busy.' } }),
    );
    const { session, sockets, errors } = await phone(fake);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().status).toBe('error');
    await session.alerts.refresh();
    await session.alerts.refresh();
    expect(session.alerts.getSnapshot()).toMatchObject({ status: 'ready', alerts: [ready] });
    // Both failed reads were reported (the menu, not served here, reports its own).
    const unavailable = errors.filter(
      (error) => error instanceof ApiRequestError && error.status === 503,
    );
    expect(unavailable).toHaveLength(2);
  });
});

describe('[NTF-004] [WTR-006] acknowledging on the phone', () => {
  it('acknowledges as the holder from the screen or the notification', async () => {
    const fake = serverListing(held(ready, bill)).on(
      'POST',
      `${ALERTS}/:alertId/acknowledge`,
      (call) => ({
        status: 200,
        body: { ...(call.path.includes(ready.id) ? ready : bill), status: 'ACKNOWLEDGED' },
      }),
    );
    const { session, sockets, notifier } = await phone(fake);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().alerts).toHaveLength(2);

    await session.alerts.acknowledge(ready.id);
    expect(fake.callsTo('POST', `${ALERTS}/${ready.id}/acknowledge`)).toHaveLength(1);
    expect(session.alerts.getSnapshot().alerts).toEqual([bill]);

    notifier.pressAcknowledge(bill.id);
    await expect.poll(() => session.alerts.getSnapshot().alerts).toEqual([]);
    expect(notifier.dismissed).toEqual([ready.id, bill.id]);
  });

  it('takes off what was acknowledged or cleared elsewhere, the pager included', async () => {
    const fake = serverListing(held(ready, bill));
    const { session, sockets, notifier } = await phone(fake);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().alerts).toHaveLength(2);
    const before = reads(fake);

    sockets.last.fire(
      'event',
      eventFrame(7, 'AlertAcknowledged', {
        alertId: ready.id,
        acknowledgedBy: STAFF.WAITER.staffId,
        recipients: ready.recipientIds,
      }),
    );
    sockets.last.fire(
      'event',
      eventFrame(8, 'AlertCleared', { alertId: bill.id, recipients: bill.recipientIds }),
    );
    expect(session.alerts.getSnapshot().alerts).toEqual([]);
    expect(notifier.dismissed).toEqual([ready.id, bill.id]);
    expect(reads(fake)).toBe(before);
  });

  it('takes off an alert already gone, and keeps one it could not acknowledge', async () => {
    const fake = serverListing(held(ready, bill)).on(
      'POST',
      `${ALERTS}/:alertId/acknowledge`,
      () => ({ status: 404, body: { code: 'ALERT_NOT_FOUND', message: 'Gone.' } }),
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'Busy.' } }),
    );
    const { session, sockets } = await phone(fake);
    sockets.sync();
    await expect.poll(() => session.alerts.getSnapshot().alerts).toHaveLength(2);

    await session.alerts.acknowledge(ready.id);
    expect(session.alerts.getSnapshot().alerts).toEqual([bill]);
    await expect(session.alerts.acknowledge(bill.id)).rejects.toThrow('Busy.');
    expect(session.alerts.getSnapshot().alerts).toEqual([bill]);
  });

  it('forgets the alerts when the phone is unpaired', async () => {
    const fake = serverListing(held(ready));
    const { session, sockets, notifier } = await phone(fake);
    sockets.sync();
    await expect.poll(() => notifier.holder).toEqual(HOLDER);
    fake.on('GET', '/api/v1/devices/current', () => ({
      status: 401,
      body: { code: 'DEVICE_NOT_RECOGNISED', message: 'Pair it.' },
    }));
    fake.on('POST', '/api/v1/devices/token', () => ({
      status: 401,
      body: { code: 'DEVICE_AUTH_FAILED', message: 'Pair it again.' },
    }));
    sockets.last.fire('ended', { reason: 'DEVICE_REVOKED' });
    sockets.last.fire('disconnect', 'io server disconnect');
    await expect.poll(() => session.getSnapshot().phase).toBe('unpaired');
    expect(session.alerts.getSnapshot()).toEqual({ status: 'idle', holder: null, alerts: [] });
    expect(notifier.holder).toBeNull();
    expect(notifier.dismissed).toEqual([ready.id]);
  });
});
