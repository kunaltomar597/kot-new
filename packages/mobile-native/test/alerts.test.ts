import type { AlertView } from '@rp/contracts';
import type { AlertHolder } from '@rp/mobile-core';
import { alertView, HOLDER } from '@rp/mobile-core/testing';
import { describe, expect, it } from 'vitest';
import {
  ALERT_KEEP_ALIVE_TASK,
  type AlertNotificationText,
  type AlertNotice,
  AndroidAlertNotifier,
  type AlertsNative,
  type ListeningNotice,
  registerAlertKeepAlive,
} from '../src/index.js';

/** The catalogue's words, as the waiter app builds them from `describeAlert`. */
const TEXT: AlertNotificationText = {
  listening: (holder: AlertHolder) => ({
    title: `Alerts for ${holder.displayName}`,
    text: 'This phone rings for them, also when locked.',
  }),
  alert: (alert: AlertView) => ({
    title: `Table ${alert.tableLabel ?? '?'} · Food ready`,
    text: '',
  }),
  acknowledge: 'Acknowledge',
  channels: { alerts: 'Alerts', listening: 'Staying connected' },
};

/** The native module's stand-in: records what it was asked, and presses Acknowledge. */
function fakeAlerts(options: { enabled?: boolean; granted?: boolean } = {}) {
  const state = {
    started: [] as ListeningNotice[],
    stops: 0,
    announced: [] as AlertNotice[],
    dismissed: [] as string[],
    settingsOpened: 0,
    asked: 0,
    listeners: new Set<(event: { alertId: string }) => void>(),
  };
  let enabled = options.enabled ?? false;
  const native: AlertsNative = {
    start: (notice) => {
      state.started.push(notice);
      return Promise.resolve();
    },
    stop: () => {
      state.stops += 1;
      return Promise.resolve();
    },
    announce: (notice) => {
      state.announced.push(notice);
      return Promise.resolve();
    },
    dismiss: (alertId) => {
      state.dismissed.push(alertId);
      return Promise.resolve();
    },
    notificationsEnabled: () => Promise.resolve(enabled),
    requestPermission: () => {
      state.asked += 1;
      enabled = options.granted ?? true;
      return Promise.resolve(enabled);
    },
    openSettings: () => {
      state.settingsOpened += 1;
      return Promise.resolve();
    },
    addListener: (_event, listener) => {
      state.listeners.add(listener);
      return {
        remove: () => {
          state.listeners.delete(listener);
        },
      };
    },
  };
  const press = (alertId: string) => {
    for (const listener of state.listeners) listener({ alertId });
  };
  return { native, state, press };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('[WTR-005] the waiter phone’s alerts outside its screen', () => {
  it('listens for the holder with the catalogue’s words, and stops', async () => {
    const { native, state } = fakeAlerts();
    const notifier = new AndroidAlertNotifier(TEXT, { native: () => Promise.resolve(native) });
    await notifier.start(HOLDER);
    expect(state.started).toEqual([
      {
        title: `Alerts for ${HOLDER.displayName}`,
        text: 'This phone rings for them, also when locked.',
        alertsChannel: 'Alerts',
        listeningChannel: 'Staying connected',
      },
    ]);
    await notifier.stop();
    expect(state.stops).toBe(1);
  });

  it('[WTR-006] announces an alert with its words and the time it was raised, and takes it off', async () => {
    const { native, state } = fakeAlerts();
    const notifier = new AndroidAlertNotifier(TEXT, { native: () => Promise.resolve(native) });
    const ready = alertView({ tableLabel: '5' });
    await notifier.announce(ready);
    expect(state.announced).toEqual([
      {
        id: ready.id,
        title: 'Table 5 · Food ready',
        text: '',
        acknowledge: 'Acknowledge',
        postedAt: Date.parse(ready.createdAt),
      },
    ]);
    // A time the phone cannot read shows as now rather than in 1970.
    const before = Date.now();
    await notifier.announce({ ...ready, createdAt: 'not a time' });
    expect(state.announced[1]?.postedAt).toBeGreaterThanOrEqual(before);

    await notifier.dismiss(ready.id);
    expect(state.dismissed).toEqual([ready.id]);
  });

  it('[NTF-004] passes Acknowledge pressed on a notification on until it stops listening', async () => {
    const { native, press } = fakeAlerts();
    const notifier = new AndroidAlertNotifier(TEXT, { native: () => Promise.resolve(native) });
    const pressed: string[] = [];
    const stop = notifier.onAcknowledge((alertId) => pressed.push(alertId));
    await settled();
    press('alert-1');
    expect(pressed).toEqual(['alert-1']);
    stop();
    press('alert-2');
    expect(pressed).toEqual(['alert-1']);

    // Stopped before the module was loaded: it never listens.
    const early = notifier.onAcknowledge((alertId) => pressed.push(alertId));
    early();
    await settled();
    press('alert-3');
    expect(pressed).toEqual(['alert-1']);
  });

  it('reports a module that cannot be loaded', async () => {
    const errors: unknown[] = [];
    const notifier = new AndroidAlertNotifier(TEXT, {
      native: () => Promise.reject(new Error('Cannot find native module RpAlerts')),
      onError: (error) => errors.push(error),
    });
    notifier.onAcknowledge(() => undefined);
    await settled();
    expect(errors).toEqual([new Error('Cannot find native module RpAlerts')]);
    await expect(notifier.start(HOLDER)).rejects.toThrow('RpAlerts');
  });

  it('says whether notifications can show, asks for them and opens their settings', async () => {
    const { native, state } = fakeAlerts({ granted: false });
    const notifier = new AndroidAlertNotifier(TEXT, { native: () => Promise.resolve(native) });
    expect(await notifier.enabled()).toBe(false);
    expect(await notifier.request()).toBe(false);
    expect(state.asked).toBe(1);
    await notifier.openSettings();
    expect(state.settingsOpened).toBe(1);
  });
});

describe('[WTR-005] the task that keeps JavaScript running with the screen off', () => {
  function registered(ensureSession: () => Promise<unknown>, onError?: (error: unknown) => void) {
    const tasks = new Map<string, () => (data: unknown) => Promise<void>>();
    registerAlertKeepAlive(
      (taskKey, provider) => {
        tasks.set(taskKey, provider);
      },
      ensureSession,
      onError,
    );
    return tasks;
  }

  it('starts the device session and never finishes by itself', async () => {
    let sessions = 0;
    const tasks = registered(() => {
      sessions += 1;
      return Promise.resolve();
    });
    expect([...tasks.keys()]).toEqual([ALERT_KEEP_ALIVE_TASK]);
    const task = tasks.get(ALERT_KEEP_ALIVE_TASK)?.();
    let finished = false;
    void task?.({}).then(() => {
      finished = true;
    });
    await settled();
    expect(sessions).toBe(1);
    expect(finished).toBe(false);
  });

  it('keeps running when the session cannot start, and reports it', async () => {
    const errors: unknown[] = [];
    const tasks = registered(
      () => Promise.reject(new Error('The secure store is locked')),
      (error) => errors.push(error),
    );
    let finished = false;
    void tasks
      .get(ALERT_KEEP_ALIVE_TASK)?.()({})
      .finally(() => {
        finished = true;
      });
    await settled();
    expect(errors).toEqual([new Error('The secure store is locked')]);
    expect(finished).toBe(false);
  });
});
