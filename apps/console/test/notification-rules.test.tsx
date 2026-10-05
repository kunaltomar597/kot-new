import type { SettingKey } from '@rp/contracts';
import type { NotificationEvent } from '@rp/domain';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer, RecordedCall } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { settingsChanged, settingView, settingViews } from './settings-fixture.js';

type Changes = Readonly<Partial<Record<SettingKey, unknown>>>;

/** A fake server holding the settings: a change is kept and listed from then on. */
function rulesServer(initial: Changes = {}): FakeServer {
  let changes: Changes = initial;
  const update = (call: RecordedCall) => {
    const key = call.path.split('/').pop() as SettingKey;
    changes = { ...changes, [key]: (call.body as { value: unknown }).value };
    return { status: 200, body: settingView('MANAGER', key, changes) };
  };
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/settings', () => ({
      status: 200,
      body: { settings: settingViews('MANAGER', changes) },
    }))
    .on('PUT', '/api/v1/settings/notifications.rules', update)
    .on('PUT', '/api/v1/settings/notifications.escalationSeconds', update);
}

/** `text` matched literally, braces and all. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A label that starts with `text`, followed by any hint. */
const labelled = (text: string) => new RegExp(`^${literally(text)}`);
const nameOf = (event: NotificationEvent) => t(`alerts.type.${event}`);
const ruleOf = async (event: NotificationEvent) =>
  (await screen.findByRole('heading', { level: 4, name: nameOf(event) })).closest(
    'li',
  ) as HTMLElement;
const settingRowOf = async (key: SettingKey) =>
  (await screen.findByRole('heading', { level: 4, name: t(`settingItems.${key}.label`) })).closest(
    'li',
  ) as HTMLElement;
const changeRule = (event: NotificationEvent) =>
  screen.findByRole('button', {
    name: t('notificationRules.row.changeLabel', { name: nameOf(event) }),
  });
const dialogFor = (event: NotificationEvent) =>
  screen.findByRole('dialog', { name: nameOf(event) });
const rulePuts = (fake: FakeServer) =>
  fake.callsTo('PUT', '/api/v1/settings/notifications.rules').map((call) => call.body);
const save = () => screen.getByRole('button', { name: t('settings.dialog.save') });

/**
 * Waits until the row shows `text`. The page reads the settings again after a save, and 250 ms
 * after a live event, which on a busy runner outlasts `waitFor`'s 1 s default.
 */
async function expectRowToShow(row: Promise<HTMLElement>, text: string): Promise<void> {
  const found = await row;
  await waitFor(
    () => {
      expect(within(found).getByText(text)).toBeVisible();
    },
    { timeout: 5_000 },
  );
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[NTF-002] [NTF-003] the Notifications page', () => {
  it('lists a rule for every alert, saying whom it alerts, where, and what the pager shows', async () => {
    const fake = rulesServer({ 'notifications.rules': { BILL_REQUEST: { escalate: false } } });
    const { container, user } = await renderConsole({
      fake,
      path: '/manage/settings',
      signedIn: 'MANAGER',
    });
    const pages = await screen.findByRole('navigation', { name: t('settings.pages.label') });
    await user.click(within(pages).getByRole('link', { name: t('settings.pages.notifications') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('notificationRules.title') }),
    ).toBeVisible();
    await ruleOf('WATER_REQUEST');
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      t('notificationRules.timing'),
      t('notificationRules.groups.orders'),
      t('notificationRules.groups.tables'),
      t('notificationRules.groups.staff'),
      t('notificationRules.groups.system'),
    ]);

    // N, R and the nudge messages first, changed here as on the General page.
    const escalation = await settingRowOf('notifications.escalationSeconds');
    expect(within(escalation).getByText('60 seconds')).toBeVisible();
    await settingRowOf('notifications.repeatSeconds');
    await settingRowOf('notifications.nudgePresets');

    // A table request: to its waiter on pager and phone, with its text, buzz, repeat and N.
    const water = await ruleOf('WATER_REQUEST');
    expect(
      within(water).getByText(
        t('notificationRules.row.to', { people: t('notificationRules.people.RESPONSIBLE_WAITER') }),
      ),
    ).toBeVisible();
    expect(within(water).getByText(t('notificationRules.places.PHONES'))).toBeVisible();
    expect(within(water).queryByText(t('notificationRules.places.SCREENS'))).toBeNull();
    expect(
      within(water).getByText(
        t('notificationRules.row.pager', {
          text: 'T7 WATER',
          vibration: t('notificationRules.vibration.TWO_SHORT'),
        }),
      ),
    ).toBeVisible();
    expect(
      within(water).getByText(t('notificationRules.repeat.UNTIL_ACKED', { every: '60 seconds' })),
    ).toBeVisible();
    expect(
      within(water).getByText(t('notificationRules.row.escalates', { after: '60 seconds' })),
    ).toBeVisible();
    expect(within(water).queryByText(t('notificationRules.row.changed'))).toBeNull();

    // A changed rule says so; food ready also shows on the table's tablet.
    const bill = await ruleOf('BILL_REQUEST');
    expect(within(bill).getByText(t('notificationRules.row.changed'))).toBeVisible();
    expect(
      within(bill).queryByText(t('notificationRules.row.escalates', { after: '60 seconds' })),
    ).toBeNull();
    expect(
      within(await ruleOf('ITEM_READY')).getByText(t('notificationRules.places.TABLET')),
    ).toBeVisible();

    // What always happens is shown, and not offered for change.
    const changed = await ruleOf('ORDER_CHANGED');
    expect(within(changed).getByText(t('notificationRules.row.fixed'))).toBeVisible();
    expect(within(changed).getByText(t('notificationRules.fixed.ORDER_CHANGED'))).toBeVisible();
    expect(within(changed).getByText(t('notificationRules.places.KDS'))).toBeVisible();
    expect(within(changed).queryByRole('button')).toBeNull();
    expect(within(await ruleOf('WAITER_UNREACHABLE')).queryByRole('button')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('[PGR-006] [AUD-001] changes who gets an alert, its pager text and buzz, keeping other changes', async () => {
    const fake = rulesServer({ 'notifications.rules': { BILL_REQUEST: { escalate: false } } });
    const { container, user } = await renderConsole({
      fake,
      path: '/manage/settings/notifications',
      signedIn: 'MANAGER',
    });
    await user.click(await changeRule('WATER_REQUEST'));
    const dialog = await dialogFor('WATER_REQUEST');
    expect(within(dialog).getByText(t('notificationRules.events.WATER_REQUEST'))).toBeVisible();
    expect(within(dialog).getByText(t('notificationRules.dialog.factory'))).toBeVisible();
    expect(
      within(dialog).getByRole('checkbox', {
        name: t('notificationRules.recipients.RESPONSIBLE_WAITER'),
      }),
    ).toBeChecked();
    await expectNoAxeViolations(container);

    await user.click(
      within(dialog).getByRole('checkbox', { name: t('notificationRules.recipients.CASHIER') }),
    );
    const text = within(dialog).getByLabelText(labelled(t('notificationRules.dialog.pagerText')));
    expect(text).toHaveValue('{table} WATER');
    expect(text).toHaveAccessibleDescription(
      t('notificationRules.dialog.pagerTextTable', {
        max: 20,
        placeholder: '{table}',
        example: 'T7',
      }),
    );
    await user.clear(text);
    await user.type(text, '{{table} jal');
    expect(
      within(dialog).getByText(t('notificationRules.dialog.preview', { text: 'T7 JAL' })),
    ).toBeVisible();
    await user.selectOptions(
      within(dialog).getByLabelText(labelled(t('notificationRules.dialog.vibration'))),
      'THREE',
    );
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: t('notificationRules.dialog.escalate', { after: '60 seconds' }),
      }),
    );
    expect(within(dialog).getByText(t('notificationRules.dialog.notFactory'))).toBeVisible();
    await user.type(
      within(dialog).getByLabelText(labelled(t('settings.dialog.reason'))),
      'Cashier fills the jugs',
    );
    await user.click(save());

    expect(
      await screen.findByText(
        t('notificationRules.dialog.saved', { name: nameOf('WATER_REQUEST') }),
      ),
    ).toBeVisible();
    // The rules were read again just before saving, so the change to the bill rule is kept.
    expect(rulePuts(fake)).toEqual([
      {
        value: {
          BILL_REQUEST: { escalate: false },
          WATER_REQUEST: {
            recipients: ['RESPONSIBLE_WAITER', 'CASHIER'],
            pagerText: '{table} jal',
            vibration: 'THREE',
            escalate: false,
          },
        },
        reason: 'Cashier fills the jugs',
      },
    ]);
    await expectRowToShow(ruleOf('WATER_REQUEST'), t('notificationRules.row.changed'));
    await expectRowToShow(
      ruleOf('WATER_REQUEST'),
      t('notificationRules.row.to', {
        people: `${t('notificationRules.people.RESPONSIBLE_WAITER')} and ${t('notificationRules.people.CASHIER')}`,
      }),
    );
    expect(
      within(await ruleOf('WATER_REQUEST')).getByText(
        t('notificationRules.row.pager', {
          text: 'T7 JAL',
          vibration: t('notificationRules.vibration.THREE'),
        }),
      ),
    ).toBeVisible();
  });

  it('checks a rule before sending it', async () => {
    const fake = rulesServer();
    const { user } = await renderConsole({
      fake,
      path: '/manage/settings/notifications',
      signedIn: 'MANAGER',
    });
    await user.click(await changeRule('WATER_REQUEST'));
    const dialog = await dialogFor('WATER_REQUEST');
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: t('notificationRules.recipients.RESPONSIBLE_WAITER'),
      }),
    );
    const text = within(dialog).getByLabelText(labelled(t('notificationRules.dialog.pagerText')));
    await user.clear(text);
    await user.type(text, 'HELLO {{message}');
    await user.click(save());
    expect(
      within(dialog).getByText(t('notificationRules.dialog.problems.NO_RECIPIENT')),
    ).toBeVisible();
    expect(text).toHaveAccessibleDescription(
      expect.stringContaining(
        t('notificationRules.dialog.problems.PAGER_TEXT_PLACEHOLDER', { allowed: '{table}' }),
      ) as string,
    );

    // Nowhere to show it: the pager's text is no longer asked for.
    await user.click(
      within(dialog).getByRole('checkbox', { name: t('notificationRules.places.PHONES') }),
    );
    expect(
      within(dialog).queryByLabelText(labelled(t('notificationRules.dialog.pagerText'))),
    ).toBeNull();
    expect(
      within(dialog).getByText(t('notificationRules.dialog.problems.NO_CHANNEL')),
    ).toBeVisible();
    expect(rulePuts(fake)).toEqual([]);

    // Shown on the POS and dashboard instead, to the managers: that works.
    await user.click(
      within(dialog).getByRole('checkbox', { name: t('notificationRules.places.SCREENS') }),
    );
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: t('notificationRules.recipients.MANAGERS_ON_DUTY'),
      }),
    );
    await user.click(save());
    await waitFor(() => {
      expect(rulePuts(fake)).toEqual([
        {
          value: {
            WATER_REQUEST: {
              recipients: ['MANAGERS_ON_DUTY'],
              channels: ['POS', 'DASHBOARD'],
              pagerText: 'HELLO {message}',
            },
          },
        },
      ]);
    });
  });

  it('[NTF-008] keeps a nudge going to the chosen waiters with their message', async () => {
    const fake = rulesServer();
    const { user } = await renderConsole({
      fake,
      path: '/manage/settings/notifications',
      signedIn: 'MANAGER',
    });
    await user.click(await changeRule('MANAGER_NUDGE'));
    const dialog = await dialogFor('MANAGER_NUDGE');
    const chosen = within(dialog).getByRole('checkbox', {
      name: t('notificationRules.recipients.SELECTED'),
    });
    expect(chosen).toBeChecked();
    expect(chosen).toBeDisabled();
    const text = within(dialog).getByLabelText(labelled(t('notificationRules.dialog.pagerText')));
    expect(
      within(dialog).getByText(
        t('notificationRules.dialog.preview', {
          text: `MGR: ${t('notificationRules.dialog.exampleMessage')}`,
        }),
      ),
    ).toBeVisible();
    await user.clear(text);
    await user.type(text, 'BOSS');
    await user.click(save());
    expect(text).toHaveAccessibleDescription(
      expect.stringContaining(
        t('notificationRules.dialog.problems.PAGER_TEXT_NEEDS_MESSAGE', {
          placeholder: '{message}',
        }),
      ) as string,
    );
    expect(rulePuts(fake)).toEqual([]);
  });

  it('goes back to the factory rule, and closes without saving when nothing changed', async () => {
    const fake = rulesServer({
      'notifications.rules': {
        BILL_REQUEST: { pagerText: '{table} CHEQUE', vibration: 'THREE' },
        ITEM_READY: { repeat: 'NONE' },
      },
    });
    const { user } = await renderConsole({
      fake,
      path: '/manage/settings/notifications',
      signedIn: 'MANAGER',
    });
    await user.click(await changeRule('ITEM_READY'));
    let dialog = await dialogFor('ITEM_READY');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(await changeRule('BILL_REQUEST'));
    dialog = await dialogFor('BILL_REQUEST');
    expect(within(dialog).getByText(t('notificationRules.dialog.notFactory'))).toBeVisible();
    await user.click(
      within(dialog).getByRole('button', { name: t('notificationRules.dialog.useFactory') }),
    );
    expect(within(dialog).getByText(t('notificationRules.dialog.factory'))).toBeVisible();
    expect(
      within(dialog).getByLabelText(labelled(t('notificationRules.dialog.pagerText'))),
    ).toHaveValue('{table} BILL');
    await user.click(save());
    await waitFor(() => {
      expect(rulePuts(fake)).toEqual([{ value: { ITEM_READY: { repeat: 'NONE' } } }]);
    });
    await waitFor(
      async () => {
        expect(
          within(await ruleOf('BILL_REQUEST')).queryByText(t('notificationRules.row.changed')),
        ).toBeNull();
      },
      { timeout: 5_000 },
    );

    // Opening a rule and saving it unchanged sends nothing.
    await user.click(await changeRule('WATER_REQUEST'));
    dialog = await dialogFor('WATER_REQUEST');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(rulePuts(fake)).toHaveLength(1);
  });

  it('[NTF-005] changes N here, and every rule that escalates says so', async () => {
    const fake = rulesServer();
    const { user } = await renderConsole({
      fake,
      path: '/manage/settings/notifications',
      signedIn: 'MANAGER',
    });
    const label = t('settingItems.notifications.escalationSeconds.label');
    await user.click(
      await screen.findByRole('button', { name: t('settings.row.changeLabel', { name: label }) }),
    );
    const dialog = await screen.findByRole('dialog', { name: label });
    const field = within(dialog).getByLabelText(labelled(label));
    await user.clear(field);
    await user.type(field, '90');
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.save') }));
    expect(await screen.findByText(t('settings.dialog.saved', { name: label }))).toBeVisible();
    expect(
      fake
        .callsTo('PUT', '/api/v1/settings/notifications.escalationSeconds')
        .map((call) => call.body),
    ).toEqual([{ value: 90 }]);
    await expectRowToShow(
      ruleOf('WATER_REQUEST'),
      t('notificationRules.row.escalates', { after: '90 seconds' }),
    );
  });

  it('shows the server’s reason when it refuses a rule, and keeps up with changes made elsewhere', async () => {
    const fake = rulesServer();
    fake.on('PUT', '/api/v1/settings/notifications.rules', () => ({
      status: 422,
      body: { code: 'SETTING_INVALID', message: 'notifications.rules: WATER_REQUEST NO_CHANNEL' },
    }));
    const { user, sockets } = await renderConsole({
      fake,
      path: '/manage/settings/notifications',
      signedIn: 'MANAGER',
    });
    await user.click(await changeRule('WATER_REQUEST'));
    const dialog = await dialogFor('WATER_REQUEST');
    await user.selectOptions(
      within(dialog).getByLabelText(labelled(t('notificationRules.dialog.vibration'))),
      'ONE_LONG',
    );
    await user.click(save());
    expect(await within(dialog).findByRole('alert')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.cancel') }));

    // Another manager changes the bill rule: the page reads the rules again.
    fake.on('GET', '/api/v1/settings', () => ({
      status: 200,
      body: {
        settings: settingViews('MANAGER', {
          'notifications.rules': { BILL_REQUEST: { recipients: ['CASHIER'] } },
        }),
      },
    }));
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', settingsChanged(1, ['notifications.rules']));
    });
    await expectRowToShow(
      ruleOf('BILL_REQUEST'),
      t('notificationRules.row.to', { people: t('notificationRules.people.CASHIER') }),
    );
  });
});
