import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { settingsAsManager, settingView } from './settings-fixture.js';

const PATH = '/manage/settings/notifications';
const RULES = '/api/v1/settings/notifications.rules';

function withRules(value: object, editable = true) {
  const list = settingsAsManager();
  list.settings = list.settings.map((setting) =>
    setting.key === 'notifications.rules'
      ? settingView('notifications.rules', {
          value,
          isDefault: Object.keys(value).length === 0,
          editable,
        })
      : setting,
  );
  return list;
}

function rulesServer(...lists: ReturnType<typeof withRules>[]): FakeServer {
  const answers = (lists.length === 0 ? [withRules({})] : lists).map((body) => () => ({
    status: 200,
    body,
  }));
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/settings', ...answers)
    .on('GET', '/api/v1/printers', () => ({ status: 200, body: { printers: [] } }))
    .on('PUT', RULES, (call) => ({
      status: 200,
      body: settingView('notifications.rules', { value: (call.body as { value: object }).value }),
    }));
}

const rowOf = async (event: 'WATER_REQUEST' | 'ITEM_READY' | 'ORDER_CHANGED') =>
  (await screen.findByRole('heading', { level: 3, name: t(`alerts.type.${event}`) })).closest(
    'li',
  ) as HTMLElement;

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[NTF-002] the notification rules', () => {
  it('shows each event’s Appendix C rule with N and R from the settings', async () => {
    const { container } = await renderConsole({
      fake: rulesServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByText(
        t('notificationRules.intro', {
          escalation: t('notificationRules.seconds', { value: 60 }),
          repeat: t('notificationRules.seconds', { value: 60 }),
        }),
      ),
    ).toBeVisible();
    const water = await rowOf('WATER_REQUEST');
    expect(
      within(water).getByText(
        t('notificationRules.who', { list: t('notificationRules.recipient.RESPONSIBLE_WAITER') }),
      ),
    ).toBeVisible();
    expect(within(water).getByText(t('notificationRules.factory'))).toBeVisible();
    expect(within(water).getByText(/T4 WATER|\{table\} WATER/)).toBeVisible();
    const kitchen = await rowOf('ORDER_CHANGED');
    expect(within(kitchen).getByText(new RegExp(t('notificationRules.noPager')))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('stores only what a manager changes, and asks for the pager line', async () => {
    const fake = rulesServer(
      withRules({}),
      withRules({ WATER_REQUEST: { recipients: ['SECTION_WAITERS'], escalate: false } }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(
        await screen.findByRole('group', {
          name: t('notificationRules.actionsFor', { name: t('alerts.type.WATER_REQUEST') }),
        }),
      ).getByRole('button', { name: t('notificationRules.edit') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('notificationRules.dialog.title', { name: t('alerts.type.WATER_REQUEST') }),
      }),
    );
    await user.click(
      dialog.getByRole('checkbox', { name: t('notificationRules.recipient.RESPONSIBLE_WAITER') }),
    );
    await user.click(
      dialog.getByRole('checkbox', { name: t('notificationRules.recipient.SECTION_WAITERS') }),
    );
    await user.click(
      dialog.getByRole('checkbox', { name: t('notificationRules.dialog.escalate') }),
    );
    const pagerText = dialog.getByRole('textbox', {
      name: t('notificationRules.dialog.pagerText'),
    });
    await user.clear(pagerText);
    await user.click(dialog.getByRole('button', { name: t('notificationRules.dialog.save') }));
    expect(dialog.getByText(t('notificationRules.problems.PAGER_TEXT_REQUIRED'))).toBeVisible();
    expect(fake.callsTo('PUT', RULES)).toHaveLength(0);

    await user.type(pagerText, '{{table} WATER');
    await user.click(dialog.getByRole('button', { name: t('notificationRules.dialog.save') }));
    expect(
      await screen.findByText(
        t('notificationRules.saved', { name: t('alerts.type.WATER_REQUEST') }),
      ),
    ).toBeVisible();
    expect(fake.callsTo('PUT', RULES)[0]?.body).toEqual({
      value: { WATER_REQUEST: { recipients: ['SECTION_WAITERS'], escalate: false } },
    });
    expect(
      await within(await rowOf('WATER_REQUEST')).findByText(t('notificationRules.changed')),
    ).toBeVisible();
  });

  it('sets a changed rule back to the factory one', async () => {
    const changed = { ITEM_READY: { escalate: false }, WATER_REQUEST: { repeat: 'NONE' } };
    const fake = rulesServer(withRules(changed), withRules({ WATER_REQUEST: { repeat: 'NONE' } }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await rowOf('ITEM_READY')).getByRole('button', { name: t('notificationRules.reset') }),
    );
    await waitFor(() => {
      expect(fake.callsTo('PUT', RULES)[0]?.body).toEqual({
        value: { WATER_REQUEST: { repeat: 'NONE' } },
      });
    });
  });

  it('is read-only for someone who may not change it, and linked from Settings', async () => {
    const fake = rulesServer(withRules({}, false));
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    const row = (
      await screen.findByRole('heading', { level: 4, name: t('settingLabels.notifications.rules') })
    ).closest('li') as HTMLElement;
    expect(
      within(row).getByText(t('settingsPage.pageValue.notifications', { count: 0 })),
    ).toBeVisible();
    await user.click(
      within(row).getByRole('link', { name: t('settingsPage.openPage.notifications') }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: t('notificationRules.title') }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: t('notificationRules.edit') })).toBeNull();
  });
});
