import { screen, waitFor, within } from '@testing-library/react';
import type { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

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
    expect(await screen.findByText(t('connection.offline'))).toBeInTheDocument();
    // A kitchen screen also covers the board: tickets must not look current (KDS-012).
    expect(screen.getByText(t('kds.disconnectedTitle'))).toBeInTheDocument();
    sockets.sync(2);
    await waitFor(() => {
      expect(screen.queryByText(t('connection.offline'))).toBeNull();
    });
    expect(screen.queryByText(t('kds.disconnectedTitle'))).toBeNull();
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
