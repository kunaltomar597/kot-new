import { createTranslator } from '@rp/i18n';
import { render, type RenderResult } from '@testing-library/react';
import { type UserEvent, userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router';
import { expect } from 'vitest';
import { App } from '../src/App.js';
import { ConsoleController } from '../src/app/console-controller.js';
import { MemoryStorage } from '../src/app/storage.js';
import { FakeServer } from './fake-server.js';
import {
  DEVICE_ID,
  deviceSummary,
  inMinutes,
  login,
  RESTAURANT_ID,
  SocketFactory,
  STAFF,
} from './fakes.js';

/** The whole console against a fake server and fake sockets, for screen tests. */

export const BASE = 'http://pos.test';
export const t = createTranslator();

const fakeKeyPair = () =>
  Promise.resolve({
    keyPair: { privateKey: {}, publicKey: {} } as CryptoKeyPair,
    key: {
      algorithm: 'ES256' as const,
      publicKey: 'AAAA',
      sign: () => Promise.resolve('c2lnbmF0dXJl'),
    },
  });

export function server(type: 'POS' | 'KDS' = 'POS'): FakeServer {
  return new FakeServer()
    .on('POST', '/api/v1/devices/pair', () => ({
      status: 201,
      body: {
        deviceId: DEVICE_ID,
        restaurantId: RESTAURANT_ID,
        type,
        name: 'Counter POS',
        tableId: null,
        stationId: null,
        staffId: null,
      },
    }))
    .on('POST', '/api/v1/devices/challenge', () => ({
      status: 200,
      body: { challenge: 'challenge-0123456789', expiresAt: inMinutes(1) },
    }))
    .on('POST', '/api/v1/devices/token', () => ({
      status: 200,
      body: { deviceToken: 'device-token-1', expiresAt: inMinutes(60) },
    }))
    .on('GET', '/api/v1/devices/current', () => ({
      status: 200,
      body: deviceSummary({ type, name: type === 'KDS' ? 'Tandoor screen' : 'Counter POS' }),
    }))
    .on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 200,
      body: { staff: Object.values(STAFF) },
    }))
    .on('POST', '/api/v1/auth/logout', () => ({ status: 204 }))
    .on('GET', '/api/v1/auth/session', () => ({ status: 200, body: {} }));
}

export function signsInAs(
  fake: FakeServer,
  role: keyof typeof STAFF,
  timeout?: number,
): FakeServer {
  return fake.on('POST', '/api/v1/auth/pin-login', () => ({
    status: 200,
    body: login(role, timeout),
  }));
}

export interface RenderedConsole extends RenderResult {
  readonly user: UserEvent;
  readonly controller: ConsoleController;
  readonly sockets: SocketFactory;
  readonly fake: FakeServer;
  readonly storage: MemoryStorage;
}

export async function renderConsole(
  options: { fake?: FakeServer; path?: string; pair?: boolean; signedIn?: keyof typeof STAFF } = {},
): Promise<RenderedConsole> {
  const fake = options.fake ?? server();
  const sockets = new SocketFactory();
  const storage = new MemoryStorage();
  const controller = new ConsoleController({
    baseUrl: BASE,
    storage,
    fetch: fake.fetch,
    connect: sockets.connect,
    generateKey: fakeKeyPair,
    keyFromPair: async () => (await fakeKeyPair()).key,
  });
  await controller.start();
  if (options.pair !== false) await controller.pair('ABCD-EFGH');
  if (options.signedIn !== undefined) {
    await controller.signIn(STAFF[options.signedIn].staffId, '1234');
  }
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[options.path ?? '/']}>
      <App controller={controller} translator={t} />
    </MemoryRouter>,
  );
  return { ...view, user, controller, sockets, fake, storage };
}

export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}
