import { createTranslator } from '@rp/i18n';
import {
  ApkUpdater,
  createDeviceErrorReporting,
  DeviceSession,
  OtaUpdater,
  watchUncaughtErrors,
} from '@rp/mobile-core';
import {
  AndroidAlertNotifier,
  AndroidApkInstaller,
  AndroidServerTrust,
  ExpoOtaUpdates,
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
  const session = new DeviceSession({
    secureStore: await secureStore(),
    plainStore: await plainStore(),
    keys: new KeystoreDeviceKeys(),
    trust: new AndroidServerTrust(),
    // The phone alerts the person who last signed in on it, like their pager (P2-06a, WTR-006),
    // also with the screen off or the app closed (P2-06b, WTR-005).
    followAlerts: true,
    alertNotifier: notifier,
    appKind: 'waiter-app',
    ...(Constants.expoConfig?.version !== undefined && {
      appVersion: Constants.expoConfig.version,
    }),
  });
  // NFR-O02: uncaught errors reach the vendor through the restaurant's server, scrubbed.
  watchUncaughtErrors(
    createDeviceErrorReporting(session, 'waiter-app', Constants.expoConfig?.version ?? null),
  );
  return session;
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

let updating: Promise<OtaUpdater> | undefined;

/**
 * The phone's over-the-air updates (P7-04e1, UPD-001), started with the screen and never stopped:
 * EAS updates its server speaks, applied while nobody is signed in and the app is on screen.
 */
export function appUpdater(): Promise<OtaUpdater> {
  updating ??= Promise.all([deviceSession(), ExpoOtaUpdates.load()]).then(([session, source]) => {
    const updater = new OtaUpdater({
      session,
      source,
      onError: createDeviceErrorReporting(
        session,
        'waiter-app',
        Constants.expoConfig?.version ?? null,
      ),
    });
    updater.start();
    return updater;
  });
  return updating;
}

let installing: Promise<ApkUpdater> | undefined;

/**
 * New APKs of the waiter app from the restaurant PC (P7-04e2, WTR-001): offered on the sign-in
 * screen and on "Update this app"; a person installs one and Android asks them to confirm.
 */
export function apkUpdater(): Promise<ApkUpdater> {
  installing ??= Promise.all([deviceSession(), AndroidApkInstaller.load()]).then(
    ([session, installer]) => {
      const updater = new ApkUpdater({
        session,
        installer,
        onError: createDeviceErrorReporting(
          session,
          'waiter-app',
          Constants.expoConfig?.version ?? null,
        ),
      });
      updater.start();
      return updater;
    },
  );
  return installing;
}
