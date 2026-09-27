import { createTranslator } from '@rp/i18n';
import { DeviceSession } from '@rp/mobile-core';
import {
  AndroidAlertNotifier,
  AndroidServerTrust,
  installRandomValues,
  KeystoreDeviceKeys,
  plainStore,
  secureStore,
} from '@rp/mobile-native';
import Constants from 'expo-constants';
import { alertNotificationText } from './notifications';

export const translator = createTranslator();

/**
 * The phone's alerts outside its screen (P2-06b, WTR-005): the service that keeps it listening
 * with the screen off, and a notification per alert with Acknowledge.
 */
export const notifier = new AndroidAlertNotifier(alertNotificationText(translator));

/**
 * Wires the device session to the Keystore, the secure store and AsyncStorage (P2-01c), and to the
 * restaurant's LAN certificate pinned at pairing (P2-01d, ADR-0011). Secure random values first:
 * every request carries a random correlation id, and every order a random idempotency key
 * (ORD-013).
 */
async function createSession(): Promise<DeviceSession> {
  await installRandomValues();
  return new DeviceSession({
    secureStore: await secureStore(),
    plainStore: await plainStore(),
    keys: new KeystoreDeviceKeys(),
    trust: new AndroidServerTrust(),
    // The phone alerts the person who last signed in on it, like their pager (P2-06a, WTR-006),
    // also with the screen off or the app closed (P2-06b, WTR-005).
    followAlerts: true,
    alertNotifier: notifier,
    ...(Constants.expoConfig?.version !== undefined && {
      appVersion: Constants.expoConfig.version,
    }),
  });
}

let created: Promise<DeviceSession> | undefined;

/**
 * The phone's one device session, created and started on first use and never stopped (P2-06b):
 * it outlives the screen, which closing the app from the recents list takes down, so alerts keep
 * coming while the alert service runs. The screen and the service's keep-alive task share it.
 */
export function deviceSession(): Promise<DeviceSession> {
  created ??= createSession().then((session) => {
    void session.start();
    return session;
  });
  return created;
}
