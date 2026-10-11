import { createTranslator } from '@rp/i18n';
import {
  ApkUpdater,
  createDeviceErrorReporting,
  DeviceSession,
  type KeyValueStore,
  OtaUpdater,
  watchUncaughtErrors,
} from '@rp/mobile-core';
import {
  AndroidScreenGuard,
  AndroidApkInstaller,
  AndroidKiosk,
  AndroidServerTrust,
  ExpoOtaUpdates,
  installRandomValues,
  KeystoreDeviceKeys,
  plainStore,
  secureStore,
} from '@rp/mobile-native';
import { setScreenGuard } from '@rp/ui-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { App } from './App';
import type { TabletDevice } from './TabletHome';

const translator = createTranslator();
const appVersion = Constants.expoConfig?.version;

interface Created {
  session: DeviceSession;
  device: TabletDevice;
  updater: OtaUpdater | undefined;
  apkUpdater: ApkUpdater | undefined;
}

/**
 * Wires the device session to the Keystore, the secure store and AsyncStorage; the session keeps
 * the menu cache in AsyncStorage (P2-01c). The restaurant's LAN certificate is pinned at pairing
 * (P2-01d, ADR-0011). Secure random values first: every request carries a random correlation id.
 * The kiosk module gives lock-task mode and the tablet's health (P3-01b). Over-the-air updates
 * follow the session (P7-04e1), and so do new APKs from the PC (P7-04e2); without them the tablet
 * still works.
 */
async function createSession(): Promise<Created> {
  await installRandomValues();
  // No screenshots or recent-apps preview of a PIN pad (MOBILE-I4); a device without it still works.
  await AndroidScreenGuard.load().then(setScreenGuard, () => undefined);
  const store: KeyValueStore = await plainStore();
  const kiosk = await AndroidKiosk.load();
  const session = new DeviceSession({
    secureStore: await secureStore(),
    plainStore: store,
    keys: new KeystoreDeviceKeys(),
    trust: new AndroidServerTrust(),
    appKind: 'table-tablet',
    ...(appVersion !== undefined && { appVersion }),
  });
  // NFR-O02: uncaught errors reach the vendor through the restaurant's server, scrubbed.
  const report = createDeviceErrorReporting(session, 'table-tablet', appVersion ?? null);
  watchUncaughtErrors(report);
  const updater = await ExpoOtaUpdates.load().then(
    (source) => new OtaUpdater({ session, source, onError: report }),
    () => undefined,
  );
  // New native code comes as an APK from the restaurant PC (P7-04e2); as device owner the tablet
  // installs it by itself between guests.
  const apkUpdater = await AndroidApkInstaller.load().then(
    (installer) => new ApkUpdater({ session, installer, onError: report }),
    () => undefined,
  );
  return {
    session,
    updater,
    apkUpdater,
    device: {
      store,
      kiosk,
      health: kiosk,
      ...(appVersion !== undefined && { appVersion }),
    },
  };
}

export function Root() {
  const [created, setCreated] = useState<Created | null>(null);
  useEffect(() => {
    let current: Created | undefined;
    void createSession().then((made) => {
      current = made;
      setCreated(made);
      made.updater?.start();
      made.apkUpdater?.start();
      return made.session.start();
    });
    return () => {
      current?.updater?.stop();
      current?.apkUpdater?.stop();
      current?.session.stop();
    };
  }, []);
  return created === null ? null : (
    <App
      session={created.session}
      translator={translator}
      device={created.device}
      {...(created.updater !== undefined && { updater: created.updater })}
      {...(created.apkUpdater !== undefined && { apkUpdater: created.apkUpdater })}
    />
  );
}
