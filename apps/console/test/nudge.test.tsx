import type { StaffTile } from '@rp/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presetsOf } from '../src/alerts/NudgeDialog.js';
import type { FakeServer } from './fake-server.js';
import { STAFF } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

const SUNITA: StaffTile = {
  staffId: '0199a0e0-0000-7000-8000-000000000106',
  displayName: 'Sunita',
  role: 'WAITER',
  customRoleName: null,
  photoId: null,
};

function managerServer(): FakeServer {
  return signsInAs(server(), 'MANAGER').on('GET', '/api/v1/auth/staff-tiles', () => ({
    status: 200,
    body: { staff: [...Object.values(STAFF), SUNITA] },
  }));
}

function withPresets(fake: FakeServer, presets: unknown): FakeServer {
  return fake.on('GET', '/api/v1/settings', () => ({
    status: 200,
    body: {
      settings: [
        {
          key: 'notifications.nudgePresets',
          value: presets,
          defaultValue: [],
          isDefault: false,
          scope: 'RESTAURANT',
          capability: 'OPERATIONS_CONFIGURE',
          editable: true,
          description: 'Messages a manager can send to waiters with one tap.',
          requirements: ['NTF-008'],
          updatedAt: null,
        },
      ],
    },
  }));
}

async function openNudge(fake: FakeServer) {
  const rendered = await renderConsole({ fake, path: '/manage/alerts', signedIn: 'MANAGER' });
  await rendered.user.click(await screen.findByRole('button', { name: t('alerts.nudge.open') }));
  const dialog = await screen.findByRole('dialog', { name: t('alerts.nudge.title') });
  return { ...rendered, dialog };
}

const nudges = (fake: FakeServer) => fake.callsTo('POST', '/api/v1/alerts/nudge');

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[NTF-008] a manager nudges waiters', () => {
  it('sends a quick message to the waiters chosen', async () => {
    const fake = withPresets(managerServer(), ['Come to counter', 'Check T7']).on(
      'POST',
      '/api/v1/alerts/nudge',
      () => ({ status: 201, body: { alertIds: [] } }),
    );
    const { user, dialog, container } = await openNudge(fake);

    const waiters = within(dialog).getByRole('group', { name: t('alerts.nudge.waiters') });
    // Only waiters: the cashier, kitchen and managers are not offered.
    expect(within(waiters).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(waiters).queryByRole('checkbox', { name: 'Asha' })).toBeNull();
    const send = within(dialog).getByRole('button', { name: t('alerts.nudge.send') });
    expect(send).toBeDisabled();

    await user.click(within(waiters).getByRole('checkbox', { name: 'Ravi' }));
    await user.click(within(waiters).getByRole('checkbox', { name: 'Sunita' }));
    const preset = await within(dialog).findByRole('button', { name: 'Check T7' });
    await user.click(preset);
    expect(preset).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByLabelText(t('alerts.nudge.message'))).toHaveValue('Check T7');
    await expectNoAxeViolations(container);

    await user.click(send);
    expect(
      await screen.findByText(t('alerts.nudge.sent', { count: 2, name: 'Ravi' })),
    ).toBeInTheDocument();
    expect(nudges(fake).map((call) => call.body)).toEqual([
      { staffIds: [STAFF.WAITER.staffId, SUNITA.staffId], message: 'Check T7' },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('alerts.nudge.title') })).toBeNull();
    });
  });

  it('sends a message of the manager’s own, up to 40 characters, without quick messages', async () => {
    // The settings cannot be read: no quick messages, the manager types one.
    const fake = managerServer().on('POST', '/api/v1/alerts/nudge', () => ({
      status: 201,
      body: { alertIds: [] },
    }));
    const { user, dialog } = await openNudge(fake);
    await within(dialog).findByRole('checkbox', { name: 'Ravi' });
    expect(within(dialog).queryByRole('group', { name: t('alerts.nudge.presets') })).toBeNull();

    const message = within(dialog).getByLabelText(t('alerts.nudge.message'));
    await user.type(message, 'Please bring the extra chairs to the terrace now');
    expect(message).toHaveValue('Please bring the extra chairs to the ter');
    expect(
      within(dialog).getByText(t('alerts.nudge.messageHint', { count: 40, max: 40 })),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Ravi' }));
    await user.click(within(dialog).getByRole('button', { name: t('alerts.nudge.send') }));

    expect(
      await screen.findByText(t('alerts.nudge.sent', { count: 1, name: 'Ravi' })),
    ).toBeInTheDocument();
    expect(nudges(fake).map((call) => call.body)).toEqual([
      { staffIds: [STAFF.WAITER.staffId], message: 'Please bring the extra chairs to the ter' },
    ]);
  });

  it('says why a nudge was refused and keeps the choice', async () => {
    const fake = withPresets(managerServer(), ['Come to counter']).on(
      'POST',
      '/api/v1/alerts/nudge',
      () => ({
        status: 422,
        body: { code: 'STAFF_NOT_FOUND', message: 'Choose people who work here and are active.' },
      }),
    );
    const { user, dialog } = await openNudge(fake);
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Ravi' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Come to counter' }));
    await user.click(within(dialog).getByRole('button', { name: t('alerts.nudge.send') }));

    expect(
      await within(dialog).findByText('Choose people who work here and are active.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Ravi' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: t('alerts.nudge.send') })).toBeEnabled();
  });

  it('says when the waiters cannot be read', async () => {
    const fake = signsInAs(server(), 'MANAGER').on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 503,
      body: { code: 'UNAVAILABLE', message: 'The server is starting.' },
    }));
    const { dialog } = await openNudge(fake);
    expect(
      await within(dialog).findByText(
        t('alerts.nudge.staffFailed', { message: 'The server is starting.' }),
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: t('alerts.nudge.send') })).toBeDisabled();
  });

  it('keeps only quick messages that fit', () => {
    expect(presetsOf(['Come to counter', '', 7, 'x'.repeat(41), ' Check T7 '])).toEqual([
      'Come to counter',
      ' Check T7 ',
    ]);
    expect(presetsOf(undefined)).toEqual([]);
  });
});
