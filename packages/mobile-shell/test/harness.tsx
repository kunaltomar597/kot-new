import { createTranslator } from '@rp/i18n';
import {
  DeviceSession,
  type DeviceSessionOptions,
  MemoryStore,
  type ServerTrust,
} from '@rp/mobile-core';
import { FakeKeys, type FakeServer, fakeLocalServer, SocketFactory } from '@rp/mobile-core/testing';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { ShellProvider } from '../src/index.js';

export const ADDRESS = 'http://pos.test:3000';
export const translator = createTranslator();
export const fakeServer = (): FakeServer => fakeLocalServer();

export function newSession(
  server: Pick<FakeServer, 'fetch'> = fakeServer(),
  trust?: ServerTrust,
  options: Pick<DeviceSessionOptions, 'followAlerts' | 'alertNotifier'> = {},
) {
  const sockets = new SocketFactory();
  const session = new DeviceSession({
    secureStore: new MemoryStore(),
    plainStore: new MemoryStore(),
    keys: new FakeKeys(),
    ...(trust !== undefined && { trust }),
    fetch: server.fetch,
    connect: sockets.connect,
    ...options,
  });
  return { session, sockets };
}

export async function renderShell(
  session: DeviceSession,
  ui: ReactElement,
): Promise<Awaited<ReturnType<typeof render>>> {
  return render(
    <ShellProvider session={session} translator={translator}>
      {ui}
    </ShellProvider>,
  );
}
