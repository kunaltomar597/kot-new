import { createTranslator } from '@rp/i18n';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const BASE = 'http://pos.test';
const t = createTranslator();

const fakeKeyPair = () =>
  Promise.resolve({
    keyPair: { privateKey: {}, publicKey: {} } as CryptoKeyPair,
    key: {
      algorithm: 'ES256' as const,
      publicKey: 'AAAA',
      sign: () => Promise.resolve('c2lnbmF0dXJl'),
    },
  });

function server(type: 'POS' | 'KDS' = 'POS'): FakeServer {
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

function signsInAs(fake: FakeServer, role: keyof typeof STAFF, timeout?: number): FakeServer {
  return fake.on('POST', '/api/v1/auth/pin-login', () => ({
    status: 200,
    body: login(role, timeout),
  }));
}

async function renderConsole(
  options: { fake?: FakeServer; path?: string; pair?: boolean; signedIn?: keyof typeof STAFF } = {},
) {
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

async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}

async function signIn(user: ReturnType<typeof userEvent.setup>, name: string, pin: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
  await screen.findByRole('heading', { name: t('login.pinFor', { name }) });
  await user.keyboard(pin);
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[AUTH-007] pairing a browser', () => {
  it('asks for a code, formats it as typed, pairs and moves on to login', async () => {
    const { user, container } = await renderConsole({ pair: false });
    const field = await screen.findByLabelText(new RegExp(t('pairing.codeLabel')));
    await expectNoAxeViolations(container);
    const submit = screen.getByRole('button', { name: t('pairing.submit') });
    expect(submit).toBeDisabled();
    await user.type(field, 'abcd efgh');
    expect(field).toHaveValue('ABCD-EFGH');
    await user.click(submit);
    expect(await screen.findByRole('heading', { name: t('login.title') })).toBeInTheDocument();
  });

  it('shows the server’s answer when the code is refused', async () => {
    const fake = server().on('POST', '/api/v1/devices/pair', () => ({
      status: 401,
      body: { code: 'PAIRING_CODE_INVALID', message: 'That code is not valid any more.' },
    }));
    const { user } = await renderConsole({ fake, pair: false });
    await user.type(await screen.findByLabelText(new RegExp(t('pairing.codeLabel'))), 'ABCDEFGH');
    await user.click(screen.getByRole('button', { name: t('pairing.submit') }));
    expect(await screen.findByText('That code is not valid any more.')).toBeInTheDocument();
  });

  it('explains that pairing needs a secure page', async () => {
    vi.stubGlobal('isSecureContext', false);
    await renderConsole({ pair: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('pairing.insecureContext'));
    expect(screen.getByLabelText(new RegExp(t('pairing.codeLabel')))).toBeDisabled();
  });
});

describe('[AUTH-001] [AUTH-004] staff tiles and PIN login', () => {
  it.each([
    ['MANAGER', 'Meera', '/manage', 'modes.manage'],
    ['OWNER', 'Kunal', '/manage', 'modes.manage'],
    ['CASHIER', 'Asha', '/pos', 'modes.pos'],
    ['WAITER', 'Ravi', '/pos', 'modes.pos'],
    ['KITCHEN', 'Imran', '/kds', 'modes.kds'],
  ] as const)('lands a %s in their mode', async (role, name, _path, heading) => {
    const { user, container } = await renderConsole({ fake: signsInAs(server(), role) });
    await expectNoAxeViolations(container);
    await signIn(user, name, '1234');
    expect(await screen.findByRole('heading', { level: 1, name: t(heading) })).toBeInTheDocument();
    expect(
      screen.getByText(t('modes.signedInAs', { name, role: t(`roles.${role}`) })),
    ).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('shows the refusal under the pad and lets someone else sign in', async () => {
    const fake = server().on('POST', '/api/v1/auth/pin-login', () => ({
      status: 401,
      body: { code: 'INVALID_CREDENTIALS', message: 'That did not match. 4 tries left.' },
    }));
    const { user } = await renderConsole({ fake });
    await signIn(user, 'Asha', '9999');
    expect(await screen.findByText('That did not match. 4 tries left.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('login.notYou') }));
    expect(screen.getByRole('heading', { name: t('login.title') })).toBeInTheDocument();
  });

  it('shows empty and failed staff lists, with a retry', async () => {
    const empty = server().on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 200,
      body: { staff: [] },
    }));
    await renderConsole({ fake: empty });
    expect(await screen.findByText(t('login.noStaff'))).toBeInTheDocument();
  });

  it('retries loading the staff list', async () => {
    const flaky = server().on(
      'GET',
      '/api/v1/auth/staff-tiles',
      () => ({ status: 500, body: { code: 'INTERNAL_ERROR', message: 'Server problem.' } }),
      () => ({ status: 200, body: { staff: [STAFF.CASHIER] } }),
    );
    const { user } = await renderConsole({ fake: flaky });
    expect(await screen.findByText('Server problem.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await screen.findByRole('button', { name: /Asha/ })).toBeInTheDocument();
  });
});

describe('[MGR-001] [KDS-001] modes', () => {
  it('offers managers every mode and signs them out', async () => {
    const { user } = await renderConsole({ fake: signsInAs(server(), 'MANAGER') });
    await signIn(user, 'Meera', '2222');
    const modes = await screen.findByRole('navigation', { name: t('modes.navigation') });
    await user.click(within(modes).getByRole('link', { name: t('modes.kds') }));
    expect(await screen.findByRole('heading', { level: 1, name: t('modes.kds') })).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('login.signOut') }));
    expect(await screen.findByRole('heading', { name: t('login.title') })).toBeInTheDocument();
  });

  it('tells a cashier they cannot open Manage and takes them back', async () => {
    const { user } = await renderConsole({
      fake: signsInAs(server(), 'CASHIER'),
      signedIn: 'CASHIER',
      path: '/manage',
    });
    expect(
      await screen.findByText(t('modes.notAllowed', { mode: t('modes.manage') })),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('modes.pos') }));
    expect(await screen.findByRole('heading', { level: 1, name: t('modes.pos') })).toBeVisible();
  });

  it('opens a kitchen screen in station mode without anybody signing in', async () => {
    const { container } = await renderConsole({ fake: server('KDS') });
    expect(await screen.findByRole('heading', { level: 1, name: t('modes.kds') })).toBeVisible();
    expect(container.querySelector('[data-theme="kds"]')).not.toBeNull();
    expect(screen.getByText('Tandoor screen')).toBeVisible();
  });

  it('sends a signed-out POS to login from a mode', async () => {
    await renderConsole({ path: '/pos' });
    expect(await screen.findByRole('heading', { name: t('login.title') })).toBeInTheDocument();
  });
});

describe('[NFR-P11] connection banner', () => {
  it('appears while the server is unreachable and goes when it is back', async () => {
    const { sockets } = await renderConsole({ fake: server('KDS') });
    await screen.findByRole('heading', { level: 1, name: t('modes.kds') });
    expect(screen.getByRole('status')).toHaveTextContent(t('connection.connecting'));
    sockets.sync(1);
    await waitFor(() => {
      expect(screen.queryByText(t('connection.connecting'))).toBeNull();
    });
    sockets.last.fire('disconnect', 'transport close');
    expect(await screen.findByRole('alert')).toHaveTextContent(t('connection.offline'));
    sockets.sync(2);
    await waitFor(() => {
      expect(screen.queryByText(t('connection.offline'))).toBeNull();
    });
  });
});

describe('[AUTH-005] inactivity', () => {
  it('warns, then signs the person out and says why', async () => {
    const { user } = await renderConsole({ fake: signsInAs(server(), 'CASHIER', 2) });
    await signIn(user, 'Asha', '3333');
    await screen.findByRole('heading', { level: 1, name: t('modes.pos') });
    expect(
      await screen.findByText(/Signing out in 1 second/, {}, { timeout: 3_000 }),
    ).toBeVisible();
    expect(
      await screen.findByText(t('login.signedOutInactive'), {}, { timeout: 3_000 }),
    ).toBeVisible();
  });

  it('shows the pairing screen again after the device is unpaired', async () => {
    const { sockets } = await renderConsole({ fake: server('KDS') });
    await screen.findByRole('heading', { level: 1, name: t('modes.kds') });
    sockets.last.fire('ended', { reason: 'DEVICE_REVOKED' });
    sockets.last.fire('disconnect', 'io server disconnect');
    expect(await screen.findByText(t('pairing.revoked'))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: t('pairing.title') })).toBeInTheDocument();
  });
});
