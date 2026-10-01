import { createTranslator } from '@rp/i18n';
import { DeviceSession, type KeyValueStore } from '@rp/mobile-core';
import {
  AndroidKiosk,
  AndroidServerTrust,
  installRandomValues,
  KeystoreDeviceKeys,
  plainStore,
  secureStore,
} from '@rp/mobile-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { App } from './App';
import type { TabletDevice } from './TabletHome';

const translator = createTranslator();
const appVersion = Constants.expoConfig?.version;

/**
 * Wires the device session to the Keystore, the secure store and AsyncStorage; the session keeps
 * the menu cache in AsyncStorage (P2-01c). The restaurant's LAN certificate is pinned at pairing
 * (P2-01d, ADR-0011). Secure random values first: every request carries a random correlation id.
 * The kiosk module gives lock-task mode and the tablet's health (P3-01b).
 */
async function createSession(): Promise<{ session: DeviceSession; device: TabletDevice }> {
  await installRandomValues();
  const store: KeyValueStore = await plainStore();
  const kiosk = await AndroidKiosk.load();
  const session = new DeviceSession({
    secureStore: await secureStore(),
    plainStore: store,
    keys: new KeystoreDeviceKeys(),
    trust: new AndroidServerTrust(),
    ...(appVersion !== undefined && { appVersion }),
  });
  return {
    session,
    device: {
      store,
      kiosk,
      health: kiosk,
      ...(appVersion !== undefined && { appVersion }),
    },
  };
}

export function Root() {
  const [created, setCreated] = useState<{
    session: DeviceSession;
    device: TabletDevice;
  } | null>(null);
  useEffect(() => {
    let current: DeviceSession | undefined;
    void createSession().then((made) => {
      current = made.session;
      setCreated(made);
      return made.session.start();
    });
    return () => current?.stop();
  }, []);
  return created === null ? null : (
    <App session={created.session} translator={translator} device={created.device} />
  );
}
