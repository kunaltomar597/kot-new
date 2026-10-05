import type { ClientApiRange } from '@rp/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OTA_CHECK_INTERVAL_MS,
  type OtaCheck,
  type OtaFetch,
  type OtaSession,
  type OtaUpdateSource,
  OtaUpdater,
} from '../src/app-updates.js';

type SessionState = ReturnType<OtaSession['getSnapshot']>;

/** The device session as the updater reads it, with the server's client API range. */
function fakeSession(range: ClientApiRange | null = { current: '1.4', oldest: '1.3' }) {
  const listeners = new Set<() => void>();
  let state: SessionState = { phase: 'paired', connection: 'connecting', clientTooOld: false };
  const getVersion = vi.fn(() =>
    Promise.resolve({
      name: 'rp-server',
      version: '1.4.0',
      apiVersion: 'v1' as const,
      node: '24.12.0',
      ...(range !== null && { clientApi: range }),
    }),
  );
  const session: OtaSession = {
    api: { getVersion } as unknown as OtaSession['api'],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
  };
  return {
    session,
    getVersion,
    set(changes: Partial<SessionState>) {
      state = { ...state, ...changes };
      for (const listener of listeners) listener();
    },
    setRange(next: ClientApiRange) {
      range = next;
    },
  };
}

/** EAS Update as `expo-updates` answers it. */
class FakeSource implements OtaUpdateSource {
  readonly calls: string[] = [];
  found: OtaCheck = { kind: 'none' };
  fetched: OtaFetch | undefined;
  fail: 'check' | 'fetch' | 'reload' | undefined;

  constructor(
    readonly enabled: boolean,
    readonly emergencyLaunchReason: string | null,
  ) {}

  check(): Promise<OtaCheck> {
    this.calls.push('check');
    return this.fail === 'check'
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(this.found);
  }

  fetch(): Promise<OtaFetch> {
    this.calls.push('fetch');
    if (this.fail === 'fetch') return Promise.reject(new Error('Code signature is not valid'));
    return Promise.resolve(this.fetched ?? this.found);
  }

  reload(): Promise<void> {
    this.calls.push('reload');
    return this.fail === 'reload' ? Promise.reject(new Error('no runtime')) : Promise.resolve();
  }
}

function fakeSource(options: { enabled?: boolean; emergency?: string } = {}) {
  const source = new FakeSource(options.enabled ?? true, options.emergency ?? null);
  return { source, calls: source.calls };
}

const update = (clientApi: string | undefined, id = 'u-1'): OtaCheck => ({
  kind: 'update',
  id,
  clientApi,
});

/** Lets the updater's awaited promises run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('[UPD-001] [UPD-006] over-the-air updates on a phone or tablet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('downloads an update the server serves when it connects, and restarts when free', async () => {
    const device = fakeSession();
    const { source, calls } = fakeSource();
    source.found = update('1.4');
    const updater = new OtaUpdater({ session: device.session, source });
    updater.start();
    expect(calls).toEqual([]);
    device.set({ connection: 'online' });
    await settle();
    expect(calls).toEqual(['check', 'fetch']);
    expect(updater.getSnapshot()).toMatchObject({
      status: 'ready',
      verdict: 'APPLY',
      updateId: 'u-1',
      clientApi: '1.4',
    });
    // Someone is signed in (or it is the default before the app says): it waits.
    updater.setBusy(true);
    expect(calls).not.toContain('reload');
    updater.setBusy(false);
    expect(calls).toEqual(['check', 'fetch', 'reload']);
    expect(updater.getSnapshot().status).toBe('applying');
  });

  it('takes an update speaking the API before the server’s (N-1)', async () => {
    const device = fakeSession({ current: '1.4', oldest: '1.3' });
    const { source } = fakeSource();
    source.found = update('1.3');
    const updater = new OtaUpdater({ session: device.session, source });
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({ status: 'ready', verdict: 'APPLY' });
  });

  it('waits for the restaurant PC when the update speaks a newer API, then takes it', async () => {
    const device = fakeSession({ current: '1.4', oldest: '1.3' });
    const { source, calls } = fakeSource();
    source.found = update('1.5');
    const updater = new OtaUpdater({ session: device.session, source });
    updater.start();
    updater.setBusy(false);
    device.set({ connection: 'online' });
    await settle();
    expect(updater.getSnapshot()).toMatchObject({
      status: 'waiting',
      verdict: 'WAIT_FOR_SERVER',
      clientApi: '1.5',
    });
    expect(calls).toEqual(['check']);

    // The PC updates in its maintenance window; the phone reconnects to it.
    device.set({ connection: 'offline' });
    device.setRange({ current: '1.5', oldest: '1.4' });
    device.set({ connection: 'online' });
    await settle();
    expect(calls).toEqual(['check', 'check', 'fetch', 'reload']);
  });

  it('never takes an update the server no longer serves, or one without its API', async () => {
    const device = fakeSession({ current: '1.4', oldest: '1.3' });
    const { source, calls } = fakeSource();
    source.found = update('1.2');
    const updater = new OtaUpdater({ session: device.session, source });
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({ status: 'skipped', verdict: 'NOT_SERVED' });
    source.found = update(undefined, 'u-2');
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({
      status: 'skipped',
      verdict: 'UNKNOWN',
      updateId: 'u-2',
    });
    expect(calls).not.toContain('fetch');
  });

  it('does not take an update from a server that does not say its API (before P7-04d)', async () => {
    const device = fakeSession(null);
    const { source } = fakeSource();
    source.found = update('1.0');
    const updater = new OtaUpdater({ session: device.session, source });
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({ status: 'skipped', verdict: 'UNKNOWN' });
  });

  it('judges again what the download brought, when a newer update came out meanwhile', async () => {
    const device = fakeSession({ current: '1.4', oldest: '1.3' });
    const { source, calls } = fakeSource();
    source.found = update('1.4', 'u-1');
    source.fetched = update('1.5', 'u-2');
    const updater = new OtaUpdater({ session: device.session, source });
    updater.setBusy(false);
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({
      status: 'waiting',
      verdict: 'WAIT_FOR_SERVER',
      updateId: 'u-2',
    });
    expect(calls).not.toContain('reload');
  });

  it('restarts at once on an update when the server refuses the app as it is', async () => {
    const device = fakeSession({ current: '1.6', oldest: '1.5' });
    const { source, calls } = fakeSource();
    source.found = update('1.6');
    const updater = new OtaUpdater({ session: device.session, source });
    updater.start();
    // A waiter is signed in, but the app is refused (426 CLIENT_TOO_OLD) and useless as it is.
    updater.setBusy(true);
    device.set({ clientTooOld: true, connection: 'stopped' });
    await settle();
    expect(calls).toEqual(['check', 'fetch', 'reload']);
  });

  it('follows a rollback to the JavaScript inside the APK', async () => {
    const device = fakeSession();
    const { source, calls } = fakeSource();
    source.found = { kind: 'rollback' };
    const updater = new OtaUpdater({ session: device.session, source });
    updater.setBusy(false);
    await updater.check();
    expect(calls).toEqual(['check', 'fetch', 'reload']);
    expect(device.getVersion).not.toHaveBeenCalled();
  });

  it('is up to date when nothing new is published, or nothing new is downloaded', async () => {
    const device = fakeSession();
    const { source, calls } = fakeSource();
    const updater = new OtaUpdater({
      session: device.session,
      source,
      now: () => new Date('2026-10-05T03:00:00.000Z'),
    });
    await updater.check();
    expect(updater.getSnapshot()).toEqual({
      status: 'idle',
      verdict: null,
      updateId: null,
      clientApi: null,
      checkedAt: new Date('2026-10-05T03:00:00.000Z'),
    });
    source.found = update('1.4');
    source.fetched = { kind: 'none' };
    await updater.check();
    expect(updater.getSnapshot().status).toBe('idle');
    expect(calls).toEqual(['check', 'check', 'fetch']);
  });

  it('[UPD-007] reports a download refused for its code signature and tries again later', async () => {
    const device = fakeSession();
    const { source, calls } = fakeSource();
    source.found = update('1.4');
    source.fail = 'fetch';
    const onError = vi.fn();
    const updater = new OtaUpdater({ session: device.session, source, onError });
    updater.start();
    updater.setBusy(false);
    await updater.check();
    expect(updater.getSnapshot().status).toBe('failed');
    expect(onError).toHaveBeenCalledWith(new Error('Code signature is not valid'));

    source.fail = undefined;
    await vi.advanceTimersByTimeAsync(OTA_CHECK_INTERVAL_MS);
    expect(calls).toEqual(['check', 'fetch', 'check', 'fetch', 'reload']);
    updater.stop();
  });

  it('reports a failed check or restart, and tries again at the next check', async () => {
    const device = fakeSession();
    const { source } = fakeSource();
    source.fail = 'check';
    const onError = vi.fn();
    const updater = new OtaUpdater({ session: device.session, source, onError });
    await updater.check();
    expect(updater.getSnapshot().status).toBe('failed');

    source.fail = 'reload';
    source.found = update('1.4');
    updater.setBusy(false);
    await updater.check();
    await settle();
    expect(updater.getSnapshot().status).toBe('failed');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('does one check at a time, and none before pairing', async () => {
    const device = fakeSession();
    const { source, calls } = fakeSource();
    const updater = new OtaUpdater({ session: device.session, source });
    device.set({ phase: 'unpaired' });
    await updater.check();
    expect(calls).toEqual([]);
    device.set({ phase: 'paired' });
    const first = updater.check();
    expect(updater.check()).toBe(first);
    await first;
    expect(calls).toEqual(['check']);
  });

  it('does nothing in a build without updates', async () => {
    const device = fakeSession();
    const { source, calls } = fakeSource({ enabled: false });
    const updater = new OtaUpdater({ session: device.session, source });
    updater.start();
    device.set({ connection: 'online' });
    await updater.check();
    expect(updater.getSnapshot().status).toBe('off');
    expect(calls).toEqual([]);
  });

  it('reports an update that failed to start (an emergency launch) once', () => {
    const device = fakeSession();
    const { source } = fakeSource({ emergency: 'JS bundle threw on start' });
    const onError = vi.fn();
    const updater = new OtaUpdater({ session: device.session, source, onError });
    updater.start();
    updater.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toContain('JS bundle threw on start');
    updater.stop();
  });

  it('tells the screens what it is doing', async () => {
    const device = fakeSession();
    const { source } = fakeSource();
    source.found = update('1.4');
    const updater = new OtaUpdater({ session: device.session, source });
    const seen: string[] = [];
    const unsubscribe = updater.subscribe(() => seen.push(updater.getSnapshot().status));
    await updater.check();
    unsubscribe();
    await updater.check();
    expect(seen).toEqual(['checking', 'downloading', 'ready']);
  });
});
