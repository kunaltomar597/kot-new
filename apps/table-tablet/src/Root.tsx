import { createTranslator } from '@rp/i18n';
import { DeviceSession, MenuCache } from '@rp/mobile-core';
import { KeystoreDeviceKeys, plainStore, secureStore } from '@rp/mobile-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { App } from './App';

const translator = createTranslator();

interface Services {
  readonly session: DeviceSession;
  readonly menu: MenuCache;
}

/** Wires the device session and menu cache to the Keystore, secure store and AsyncStorage. */
async function createServices(): Promise<Services> {
  const plain = await plainStore();
  return {
    session: new DeviceSession({
      secureStore: await secureStore(),
      plainStore: plain,
      keys: new KeystoreDeviceKeys(),
      ...(Constants.expoConfig?.version !== undefined && {
        appVersion: Constants.expoConfig.version,
      }),
    }),
    menu: new MenuCache(plain),
  };
}

export function Root() {
  const [services, setServices] = useState<Services | null>(null);
  useEffect(() => {
    let current: Services | undefined;
    void createServices().then((created) => {
      current = created;
      setServices(created);
      return created.session.start();
    });
    return () => current?.session.stop();
  }, []);
  return services === null ? null : <App {...services} translator={translator} />;
}
