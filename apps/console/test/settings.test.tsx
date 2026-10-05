import type { SettingKey, SettingView } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer, RecordedCall } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  COUNTER_PRINTER,
  KITCHEN_PRINTER,
  OLD_PRINTER,
  PRINTERS,
  settingsChanged,
  settingView,
  settingViews,
} from './settings-fixture.js';
import { ownerSecurity, SECOND_FACTOR_REQUIRED } from './staff-fixture.js';

type Role = 'MANAGER' | 'OWNER';
type Changes = Readonly<Partial<Record<SettingKey, unknown>>>;

/** A fake server holding the settings: a change is kept and listed from then on. */
function settingsServer(role: Role, initial: Changes = {}): FakeServer {
  let changes: Changes = initial;
  const update = (call: RecordedCall) => {
    const key = call.path.split('/').pop() as SettingKey;
    changes = { ...changes, [key]: (call.body as { value: unknown }).value };
    return { status: 200, body: settingView(role, key, changes) };
  };
  return signsInAs(server(), role)
    .on('GET', '/api/v1/settings', () => ({
      status: 200,
      body: { settings: settingViews(role, changes) },
    }))
    .on('GET', '/api/v1/printers', () => ({ status: 200, body: { printers: PRINTERS } }))
    .on('GET', '/api/v1/auth/owner/security', () => ({ status: 200, body: ownerSecurity() }))
    .on('PUT', '/api/v1/settings/kds.ageAmberMinutes', update)
    .on('PUT', '/api/v1/settings/billing.cashierDiscountLimitBp', update)
    .on('PUT', '/api/v1/settings/payments.otherModes', update)
    .on('PUT', '/api/v1/settings/bills.printerId', update)
    .on('PUT', '/api/v1/settings/updates.maintenanceWindow', update);
}

/** `text` matched literally, brackets and all. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A label that starts with `text`, followed by any hint. */
const labelled = (text: string) => new RegExp(`^${literally(text)}`);
const rowOf = async (key: SettingKey) =>
  (await screen.findByRole('heading', { level: 4, name: t(`settingItems.${key}.label`) })).closest(
    'li',
  ) as HTMLElement;
/**
 * Waits until `key`'s row shows `text`. The page reads the settings again after a save, and 250 ms
 * after a live event; on a busy CI runner that outlasts `waitFor`'s 1 s default, and role queries
 * on this long page are slow, so the row is found once and the wait is longer.
 */
async function expectRowToShow(key: SettingKey, text: string): Promise<void> {
  const row = await rowOf(key);
  await waitFor(
    () => {
      expect(within(row).getByText(text)).toBeVisible();
    },
    { timeout: 5_000 },
  );
}
const groupOf = (name: string) => screen.getByRole('region', { name }) as HTMLElement | undefined;
const changeButton = (key: SettingKey) =>
  screen.findByRole('button', {
    name: t('settings.row.changeLabel', { name: t(`settingItems.${key}.label`) }),
  });
const dialogFor = (key: SettingKey) =>
  screen.findByRole('dialog', { name: t(`settingItems.${key}.label`) });
const putsTo = (fake: FakeServer, key: SettingKey) =>
  fake.callsTo('PUT', `/api/v1/settings/${key}`).map((call) => call.body);

async function confirmSecondFactor(user: Awaited<ReturnType<typeof renderConsole>>['user']) {
  const confirm = await screen.findByRole('dialog', { name: t('secondFactor.title') });
  await user.type(
    await within(confirm).findByLabelText(labelled(t('secondFactor.password'))),
    'correct horse battery',
  );
  await user.type(within(confirm).getByLabelText(labelled(t('secondFactor.code'))), '123456');
  await user.click(within(confirm).getByRole('button', { name: t('secondFactor.confirm') }));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-007] the General settings page', () => {
  it('[UPD-010] [AUTH-006] lists every setting by group, saying who changes what', async () => {
    const fake = settingsServer('MANAGER', { 'kds.ageAmberMinutes': 12 });
    const { container } = await renderConsole({
      fake,
      path: '/manage',
      signedIn: 'MANAGER',
    });
    const nav = await screen.findByRole('navigation', { name: t('dashboard.navigation') });
    await act(async () => {
      within(nav)
        .getByRole('link', { name: t('dashboard.section.settings') })
        .click();
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('settings.title') }),
    ).toBeVisible();
    await rowOf('kds.ageAmberMinutes');
    expect(
      screen
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent)
        .slice(0, 3),
    ).toEqual([
      t('settings.groups.ordersAndBills'),
      t('settings.groups.kitchen'),
      t('settings.groups.notifications'),
    ]);
    expect(groupOf(t('settings.groups.kitchen'))).toBeDefined();

    // A changed setting shows its value, that it changed and its default.
    const amber = await rowOf('kds.ageAmberMinutes');
    expect(within(amber).getByText('12 minutes')).toBeVisible();
    expect(within(amber).getByText(t('settings.row.changed'))).toBeVisible();
    expect(
      within(amber).getByText(t('settings.row.default', { value: '10 minutes' })),
    ).toBeVisible();
    expect(within(amber).getByRole('button', { name: /Change/ })).toBeVisible();
    // The vendor's settings are shown, never changed here.
    const pickup = await rowOf('qr.pickupTimeoutSeconds');
    expect(within(pickup).getByText(t('settings.row.vendor'))).toBeVisible();
    expect(within(pickup).queryByRole('button')).toBeNull();
    // The Owner's tax, invoice and data settings are hers alone.
    const service = await rowOf('billing.serviceChargeEnabled');
    expect(within(service).getByText(t('settings.values.off'))).toBeVisible();
    expect(within(service).getByText(t('settings.row.ownerOnly'))).toBeVisible();
    expect(within(service).queryByRole('button')).toBeNull();
    // Settings with a page of their own are not here.
    expect(
      screen.queryByRole('heading', { name: t('settingItems.notifications.rules.label') }),
    ).toBeNull();
    // The bill printer reads by name.
    expect(
      within(await rowOf('bills.printerId')).getByText(t('settings.values.printerEachTime')),
    ).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('changes a number after checking it, and keeps up with changes made elsewhere', async () => {
    const fake = settingsServer('MANAGER');
    const { user, container, sockets } = await renderConsole({
      fake,
      path: '/manage/settings',
      signedIn: 'MANAGER',
    });
    await user.click(await changeButton('kds.ageAmberMinutes'));
    const dialog = await dialogFor('kds.ageAmberMinutes');
    const field = within(dialog).getByLabelText(
      labelled(t('settingItems.kds.ageAmberMinutes.label')),
    );
    expect(field).toHaveValue('10');
    expect(field).toHaveAccessibleDescription(
      t('settings.dialog.range', { min: '1 minute', max: '120 minutes' }),
    );
    expect(within(dialog).getByText(t('settings.dialog.default', { value: '10 minutes' })));
    expect(
      within(dialog).queryByRole('button', { name: t('settings.dialog.useDefault') }),
    ).toBeNull();
    await expectNoAxeViolations(container);

    await user.clear(field);
    await user.type(field, '0');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    expect(
      within(dialog).getByText(
        t('settings.dialog.problems.number', { min: '1 minute', max: '120 minutes' }),
      ),
    ).toBeVisible();
    expect(putsTo(fake, 'kds.ageAmberMinutes')).toEqual([]);

    await user.clear(field);
    await user.type(field, '12');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    expect(
      await screen.findByText(
        t('settings.dialog.saved', { name: t('settingItems.kds.ageAmberMinutes.label') }),
      ),
    ).toBeVisible();
    expect(putsTo(fake, 'kds.ageAmberMinutes')).toEqual([{ value: 12 }]);
    await expectRowToShow('kds.ageAmberMinutes', '12 minutes');

    // Another manager changes the discount limit: the page reads the settings again.
    fake.on('GET', '/api/v1/settings', () => ({
      status: 200,
      body: {
        settings: settingViews('MANAGER', {
          'kds.ageAmberMinutes': 12,
          'billing.cashierDiscountLimitBp': 1_500,
        }),
      },
    }));
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', settingsChanged(1, ['billing.cashierDiscountLimitBp']));
    });
    await expectRowToShow('billing.cashierDiscountLimitBp', '15 %');
  });

  it('[BILL-005] [AUD-001] takes a discount limit in percent with a reason for the audit log', async () => {
    const fake = settingsServer('MANAGER');
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    await user.click(await changeButton('billing.cashierDiscountLimitBp'));
    const dialog = await dialogFor('billing.cashierDiscountLimitBp');
    const field = within(dialog).getByLabelText(
      labelled(t('settingItems.billing.cashierDiscountLimitBp.label')),
    );
    expect(field).toHaveValue('10');
    await user.clear(field);
    await user.type(field, '12.5');
    await user.type(
      within(dialog).getByLabelText(labelled(t('settings.dialog.reason'))),
      'Festival week',
    );
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    await waitFor(() => {
      expect(putsTo(fake, 'billing.cashierDiscountLimitBp')).toEqual([
        { value: 1_250, reason: 'Festival week' },
      ]);
    });
    await expectRowToShow('billing.cashierDiscountLimitBp', '12.5 %');
  });

  it('goes back to a default, and closes without saving when nothing changed', async () => {
    const fake = settingsServer('MANAGER', { 'payments.otherModes': ['Meal card', 'Wallet'] });
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    await user.click(await changeButton('payments.otherModes'));
    let dialog = await dialogFor('payments.otherModes');
    const lines = within(dialog).getByLabelText(
      labelled(t('settingItems.payments.otherModes.label')),
    );
    expect(lines).toHaveValue('Meal card\nWallet');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Unchanged: nothing is sent.
    await user.click(await changeButton('payments.otherModes'));
    dialog = await dialogFor('payments.otherModes');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(putsTo(fake, 'payments.otherModes')).toEqual([]);

    await user.click(await changeButton('payments.otherModes'));
    dialog = await dialogFor('payments.otherModes');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.useDefault') }));
    expect(
      within(dialog).getByLabelText(labelled(t('settingItems.payments.otherModes.label'))),
    ).toHaveValue('Other');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    await waitFor(() => {
      expect(putsTo(fake, 'payments.otherModes')).toEqual([{ value: ['Other'] }]);
    });
  });

  it('chooses the bill printer and sets a daily window', async () => {
    const fake = settingsServer('MANAGER', { 'bills.printerId': OLD_PRINTER });
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    const archived = t('settings.values.printerArchived', { name: 'Old printer' });
    expect(within(await rowOf('bills.printerId')).getByText(archived)).toBeVisible();
    await user.click(await changeButton('bills.printerId'));
    const dialog = await dialogFor('bills.printerId');
    const select = within(dialog).getByRole('combobox', {
      name: t('settingItems.bills.printerId.label'),
    });
    // Active printers, and the archived one still chosen.
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      t('settings.values.printerEachTime'),
      'Counter printer',
      'Kitchen printer',
      archived,
    ]);
    await user.selectOptions(select, COUNTER_PRINTER);
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    await waitFor(() => {
      expect(putsTo(fake, 'bills.printerId')).toEqual([{ value: COUNTER_PRINTER }]);
    });
    await expectRowToShow('bills.printerId', 'Counter printer');
    expect(KITCHEN_PRINTER).not.toBe(COUNTER_PRINTER);

    await user.click(await changeButton('updates.maintenanceWindow'));
    const window = await dialogFor('updates.maintenanceWindow');
    const group = within(window).getByRole('group', {
      name: t('settingItems.updates.maintenanceWindow.label'),
    });
    const from = within(group).getByLabelText(labelled(t('settings.dialog.start')));
    const to = within(group).getByLabelText(labelled(t('settings.dialog.end')));
    await user.clear(from);
    await user.type(from, '23:30');
    await user.clear(to);
    await user.type(to, '02:00');
    expect(within(window).getByText(t('settings.dialog.overnight'))).toBeVisible();
    await user.click(within(window).getByRole('button', { name: t('settings.dialog.save') }));
    await waitFor(() => {
      expect(putsTo(fake, 'updates.maintenanceWindow')).toEqual([
        { value: { start: '23:30', end: '02:00' } },
      ]);
    });
  });

  it('[AUTH-006] [BILL-006] lets the Owner turn on the service charge after the second factor', async () => {
    let enabled = false;
    const fake = settingsServer('OWNER')
      .on('GET', '/api/v1/settings', () => ({
        status: 200,
        body: {
          settings: settingViews('OWNER', enabled ? { 'billing.serviceChargeEnabled': true } : {}),
        },
      }))
      .on(
        'PUT',
        '/api/v1/settings/billing.serviceChargeEnabled',
        () => SECOND_FACTOR_REQUIRED,
        () => {
          enabled = true;
          return {
            status: 200,
            body: settingView('OWNER', 'billing.serviceChargeEnabled', {
              'billing.serviceChargeEnabled': true,
            }),
          };
        },
      )
      .on('POST', '/api/v1/auth/step-up', () => ({
        status: 200,
        body: { secondFactorValidUntil: '2026-10-05T10:10:00.000Z' },
      }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/settings',
      signedIn: 'OWNER',
    });
    await user.click(await changeButton('billing.serviceChargeEnabled'));
    const dialog = await dialogFor('billing.serviceChargeEnabled');
    expect(within(dialog).getByText(t('settings.dialog.secondFactor'))).toBeVisible();
    const toggle = within(dialog).getByRole('checkbox', {
      name: t('settingItems.billing.serviceChargeEnabled.label'),
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await expectNoAxeViolations(container);
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    await confirmSecondFactor(user);
    expect(
      await screen.findByText(
        t('settings.dialog.saved', {
          name: t('settingItems.billing.serviceChargeEnabled.label'),
        }),
      ),
    ).toBeVisible();
    expect(putsTo(fake, 'billing.serviceChargeEnabled')).toEqual([
      { value: true },
      { value: true },
    ]);
    await expectRowToShow('billing.serviceChargeEnabled', t('settings.values.on'));
  });

  it('shows the server’s reason when it refuses a change', async () => {
    const refused: SettingView = settingView('MANAGER', 'kds.ageRedMinutes');
    const fake = settingsServer('MANAGER').on('PUT', '/api/v1/settings/kds.ageRedMinutes', () => ({
      status: 422,
      body: {
        code: 'SETTING_CONFLICT',
        message: 'The red age must be later than the amber age.',
      },
    }));
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    await user.click(await changeButton('kds.ageRedMinutes'));
    const dialog = await dialogFor('kds.ageRedMinutes');
    const field = within(dialog).getByLabelText(
      labelled(t('settingItems.kds.ageRedMinutes.label')),
    );
    await user.clear(field);
    await user.type(field, '5');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    expect(
      await within(dialog).findByText('The red age must be later than the amber age.'),
    ).toBeVisible();
    expect(refused.value).toBe(20);
  });

  it('finds settings by name or description, and lists only the changed ones', async () => {
    const fake = settingsServer('MANAGER', { 'kds.ageAmberMinutes': 12 });
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    await rowOf('kds.ageAmberMinutes');
    const search = screen.getByRole('searchbox', {
      name: labelled(t('settings.general.search')),
    });
    await user.type(search, 'amber');
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      t('settingItems.kds.ageAmberMinutes.label'),
      t('settingItems.kds.ageRedMinutes.label'),
    ]);
    await user.clear(search);
    await user.type(search, 'zebra crossing');
    expect(
      screen.getByText(t('settings.general.noMatch', { query: 'zebra crossing' })),
    ).toBeVisible();
    await user.clear(search);
    await user.click(screen.getByRole('checkbox', { name: t('settings.general.changedOnly') }));
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      t('settingItems.kds.ageAmberMinutes.label'),
    ]);
  });
});
