import { createTranslator } from '@rp/i18n';
import { DeviceSession } from '@rp/mobile-core';
import { KeystoreDeviceKeys, plainStore, secureStore } from '@rp/mobile-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { App } from './App';

const translator = createTranslator();

/** Wires the device session to the Keystore, the secure store and AsyncStorage (P2-01c). */
async function createSession(): Promise<DeviceSession> {
  return new DeviceSession({
    secureStore: await secureStore(),
    plainStore: await plainStore(),
    keys: new KeystoreDeviceKeys(),
    ...(Constants.expoConfig?.version !== undefined && {
      appVersion: Constants.expoConfig.version,
    }),
  });
}

export function Root() {
  const [session, setSession] = useState<DeviceSession | null>(null);
  useEffect(() => {
    let current: DeviceSession | undefined;
    void createSession().then((created) => {
      current = created;
      setSession(created);
      return created.start();
    });
    return () => current?.stop();
  }, []);
  return session === null ? null : <App session={session} translator={translator} />;
}
