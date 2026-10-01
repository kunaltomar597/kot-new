import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { settingsAsManager, settingView } from './settings-fixture.js';

const PATH = '/manage/settings';

function settingsServer(...answers: ReturnType<typeof settingsAsManager>[]): FakeServer {
  const lists = (answers.length === 0 ? [settingsAsManager()] : answers).map((body) => () => ({
    status: 200,
    body,
  }));
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/settings', ...lists)
    .on('GET', '/api/v1/printers', () => ({ status: 200, body: { printers: [] } }));
}

const rowOf = async (key: Parameters<typeof t>[0]) =>
  (await screen.findByRole('heading', { level: 4, name: t(key) })).closest('li') as HTMLElement;

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-007] [UPD-010] the Settings page', () => {
  it('lists every setting by area with its value, and who may change it', async () => {
    const { container } = await renderConsole({
      fake: settingsServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 3, name: t('settingsPage.area.kds') }),
    ).toBeVisible();
    const amber = await rowOf('settingLabels.kds.ageAmberMinutes');
    expect(within(amber).getByText(t('settingsPage.unit.minutes', { value: 10 }))).toBeVisible();
    expect(within(amber).getByRole('button', { name: t('settingsPage.edit') })).toBeVisible();

    // The vendor's settings are shown, never changed here.
    const qr = await rowOf('settingLabels.qr.pickupTimeoutSeconds');
    expect(within(qr).getByText(t('settingsPage.vendor'))).toBeVisible();
    expect(within(qr).queryByRole('button')).toBeNull();

    // Tax settings are the Owner's.
    const priceMode = await rowOf('settingLabels.billing.priceMode');
    expect(within(priceMode).getByText(t('settingsPage.ownerOnly'))).toBeVisible();
    expect(within(priceMode).getByText(t('settingsPage.notYours'))).toBeVisible();
    expect(within(priceMode).queryByRole('button')).toBeNull();
    expect(within(priceMode).getByText(t('settingsPage.choice.TAX_EXCLUSIVE'))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('finds a setting by words', async () => {
    const { user } = await renderConsole({
      fake: settingsServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    await user.type(await screen.findByLabelText(t('settingsPage.search')), 'amber');
    await waitFor(() => {
      expect(
        screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent),
        // The red threshold's hint says it comes later than amber.
      ).toEqual([t('settingLabels.kds.ageAmberMinutes'), t('settingLabels.kds.ageRedMinutes')]);
    });
  });

  it('changes a setting with a reason, refusing a value out of range', async () => {
    const changed = settingsAsManager();
    changed.settings = changed.settings.map((setting) =>
      setting.key === 'kds.ageAmberMinutes'
        ? settingView('kds.ageAmberMinutes', { value: 12, isDefault: false })
        : setting,
    );
    const fake = settingsServer(settingsAsManager(), changed).on(
      'PUT',
      '/api/v1/settings/kds.ageAmberMinutes',
      () => ({
        status: 200,
        body: settingView('kds.ageAmberMinutes', { value: 12, isDefault: false }),
      }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await rowOf('settingLabels.kds.ageAmberMinutes')).getByRole('button', {
        name: t('settingsPage.edit'),
      }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('settingsPage.dialog.title', { name: t('settingLabels.kds.ageAmberMinutes') }),
      }),
    );
    const field = dialog.getByRole('textbox', { name: t('settingLabels.kds.ageAmberMinutes') });
    expect(field).toHaveValue('10');
    await user.clear(field);
    await user.type(field, '500');
    await user.click(dialog.getByRole('button', { name: t('settingsPage.dialog.save') }));
    expect(dialog.getByText(t('settingsPage.dialog.invalid'))).toBeVisible();
    expect(fake.callsTo('PUT', '/api/v1/settings/kds.ageAmberMinutes')).toHaveLength(0);

    await user.clear(field);
    await user.type(field, '12');
    await user.type(
      dialog.getByRole('textbox', { name: t('settingsPage.dialog.reason') }),
      'Busy grill',
    );
    await user.click(dialog.getByRole('button', { name: t('settingsPage.dialog.save') }));
    expect(
      await screen.findByText(
        t('settingsPage.saved', { name: t('settingLabels.kds.ageAmberMinutes') }),
      ),
    ).toBeVisible();
    expect(fake.callsTo('PUT', '/api/v1/settings/kds.ageAmberMinutes')[0]?.body).toEqual({
      value: 12,
      reason: 'Busy grill',
    });
    const row = await rowOf('settingLabels.kds.ageAmberMinutes');
    expect(await within(row).findByText(t('settingsPage.changed'))).toBeVisible();
    expect(
      within(row).getByText(
        t('settingsPage.default', { value: t('settingsPage.unit.minutes', { value: 10 }) }),
      ),
    ).toBeVisible();
  });

  it('[BILL-005] sets the cashier discount limit as a percent', async () => {
    const fake = settingsServer().on(
      'PUT',
      '/api/v1/settings/billing.cashierDiscountLimitBp',
      () => ({
        status: 200,
        body: settingView('billing.cashierDiscountLimitBp', { value: 1500, isDefault: false }),
      }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const row = await rowOf('settingLabels.billing.cashierDiscountLimitBp');
    expect(within(row).getByText(t('settingsPage.unit.bp', { value: '10' }))).toBeVisible();
    await user.click(within(row).getByRole('button', { name: t('settingsPage.edit') }));
    const dialog = within(await screen.findByRole('dialog'));
    const field = dialog.getByRole('textbox', {
      name: t('settingLabels.billing.cashierDiscountLimitBp'),
    });
    await user.clear(field);
    await user.type(field, '15');
    await user.click(dialog.getByRole('button', { name: t('settingsPage.dialog.save') }));
    await waitFor(() => {
      expect(
        fake.callsTo('PUT', '/api/v1/settings/billing.cashierDiscountLimitBp')[0]?.body,
      ).toEqual({
        value: 1500,
      });
    });
  });

  it('is not linked for a cashier', async () => {
    const fake = signsInAs(server(), 'CASHIER');
    await renderConsole({ fake, path: PATH, signedIn: 'CASHIER' });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: t('dashboard.section.settings') })).toBeNull();
    });
    expect(fake.callsTo('GET', '/api/v1/settings')).toHaveLength(0);
  });
});
