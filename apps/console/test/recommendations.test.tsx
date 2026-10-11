import type { RecommendationRuleView } from '@rp/contracts';
import { IDS, MENU } from '@rp/ordering/testing';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { RULE_ID, ruleView } from './recommendations-fixture.js';
import { settingsAsManager, settingView } from './settings-fixture.js';

const PATH = '/manage/settings/recommendations';
const RULES = '/api/v1/recommendation-rules';
const PREFERENCES = '/api/v1/settings/reco.itemPreferences';

function withPreferences(value: object, editable = true) {
  const list = settingsAsManager();
  list.settings = list.settings.map((setting) =>
    setting.key === 'reco.itemPreferences'
      ? settingView('reco.itemPreferences', {
          value,
          isDefault: Object.keys(value).length === 0,
          editable,
        })
      : setting,
  );
  return list;
}

function recoServer(
  rules: RecommendationRuleView[][] = [[ruleView()]],
  settings = [withPreferences({})],
): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/menu', () => ({ status: 200, body: MENU }))
    .on('GET', '/api/v1/printers', () => ({ status: 200, body: { printers: [] } }))
    .on('GET', '/api/v1/settings', ...settings.map((body) => () => ({ status: 200, body })))
    .on('GET', RULES, ...rules.map((list) => () => ({ status: 200, body: { rules: list } })))
    .on('POST', RULES, () => ({ status: 201, body: ruleView() }))
    .on('PUT', `${RULES}/${RULE_ID}`, () => ({ status: 200, body: ruleView() }))
    .on('POST', `${RULES}/${RULE_ID}/archive`, () => ({
      status: 200,
      body: ruleView({ archivedAt: '2026-10-01T10:00:00.000Z' }),
    }))
    .on('PUT', PREFERENCES, (call) => ({
      status: 200,
      body: settingView('reco.itemPreferences', { value: (call.body as { value: object }).value }),
    }))
    .on('GET', LEARNED, () => ({ status: 200, body: NOTHING_LEARNED }));
}

const LEARNED = '/api/v1/recommendations/learned';
const NOTHING_LEARNED = { lastRun: null, minOrders: 300, associations: [] };
const LEARNT = {
  lastRun: {
    at: '2026-10-02T23:15:00.000Z',
    windowFrom: '2026-07-05',
    windowTo: '2026-10-02',
    orders: 4_210,
    baskets: 3_100,
    associations: 1,
    active: true,
    durationMs: 840,
  },
  minOrders: 300,
  associations: [
    {
      fromItemId: IDS.tikka,
      fromName: 'Paneer Tikka',
      toItemId: IDS.dal,
      toName: 'Dal Makhani',
      pairCount: 620,
      supportBp: 2_000,
      confidenceBp: 6_150,
      liftPercent: 184,
    },
  ],
};

const RULE_NAME = t('recoPage.rules.summary', { when: 'Paneer Tikka', suggest: 'Dal Makhani' });
const actions = async () =>
  within(
    await screen.findByRole('group', { name: t('recoPage.rules.actionsFor', { name: RULE_NAME }) }),
  );

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[REC-002] the recommendation rules', () => {
  it('lists each rule with what it pairs, its priority, channels, hours and dates', async () => {
    const fake = recoServer([
      [
        ruleView(),
        ruleView({
          id: '0199a0e0-0000-7000-8000-0000000000f2',
          when: { kind: 'CATEGORY', categoryId: IDS.mains },
          suggest: { kind: 'ITEM', itemId: IDS.jamun },
          priority: 20,
          channels: ['QR'],
          timeWindow: { start: '19:00', end: '23:00' },
          activeFrom: '2026-10-01',
          activeUntil: '2026-10-31',
          label: 'Something sweet',
          active: false,
        }),
      ],
    ]);
    const { container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByRole('heading', { level: 4, name: RULE_NAME })).toBeVisible();
    const second = screen
      .getByRole('heading', {
        level: 4,
        name: t('recoPage.rules.summary', {
          when: t('recoPage.rules.category', { name: 'Main Course' }),
          suggest: 'Gulab Jamun',
        }),
      })
      .closest('li') as HTMLElement;
    expect(within(second).getByText('Something sweet')).toBeVisible();
    expect(within(second).getByText(t('recoPage.rules.paused'))).toBeVisible();
    expect(
      within(second).getByText(
        [
          t('recoPage.rules.priority', { value: 20 }),
          t('recoPage.channel.QR'),
          t('recoPage.rules.hours', { start: '19:00', end: '23:00' }),
          t('recoPage.rules.between', { from: '01-10-2026', until: '31-10-2026' }),
        ].join(' · '),
      ),
    ).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('adds a rule, checking it first', async () => {
    const fake = recoServer([[], [ruleView()]]);
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('recoPage.rules.empty'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('recoPage.rules.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('recoPage.dialog.addTitle') }),
    );
    await user.click(dialog.getByRole('button', { name: t('recoPage.dialog.save') }));
    expect(dialog.getByText(t('recoPage.problems.WHEN_REQUIRED'))).toBeVisible();
    expect(fake.callsTo('POST', RULES)).toHaveLength(0);

    const [whenDish, suggestDish] = dialog.getAllByRole('combobox', {
      name: t('recoPage.dialog.dish'),
    });
    await user.selectOptions(whenDish!, 'Paneer Tikka');
    await user.selectOptions(suggestDish!, 'Dal Makhani');
    await user.type(
      dialog.getByRole('textbox', { name: t('recoPage.dialog.label') }),
      'Pairs well',
    );
    await user.click(dialog.getByRole('checkbox', { name: t('recoPage.channel.QR') }));
    await user.click(dialog.getByRole('button', { name: t('recoPage.dialog.save') }));
    expect(await screen.findByText(t('recoPage.rules.added'))).toBeVisible();
    expect(fake.callsTo('POST', RULES)[0]?.body).toEqual({
      when: { kind: 'ITEM', itemId: IDS.tikka },
      suggest: { kind: 'ITEM', itemId: IDS.dal },
      priority: 50,
      channels: ['POS', 'WAITER_APP', 'TABLE_TABLET'],
      timeWindow: null,
      activeFrom: null,
      activeUntil: null,
      label: 'Pairs well',
      active: true,
    });
    expect(await screen.findByRole('heading', { level: 4, name: RULE_NAME })).toBeVisible();
  });

  it('pauses a rule, and archives one with a reason', async () => {
    const fake = recoServer([[ruleView()], [ruleView({ active: false })], []]);
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click((await actions()).getByRole('button', { name: t('recoPage.rules.pause') }));
    await waitFor(() => {
      expect(fake.callsTo('PUT', `${RULES}/${RULE_ID}`)[0]?.body).toMatchObject({ active: false });
    });
    await user.click((await actions()).getByRole('button', { name: t('recoPage.rules.archive') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('recoPage.rules.archiveTitle') }),
    );
    await user.type(dialog.getByRole('textbox'), 'Menu changed');
    await user.click(dialog.getByRole('button', { name: t('recoPage.rules.archive') }));
    expect(await screen.findByText(t('recoPage.rules.archived'))).toBeVisible();
    expect(fake.callsTo('POST', `${RULES}/${RULE_ID}/archive`)[0]?.body).toEqual({
      reason: 'Menu changed',
    });
  });

  it('is linked from Settings, and read-only for someone who may not change it', async () => {
    const fake = recoServer([[ruleView()]], [withPreferences({ [IDS.dal]: 'PIN' }, false)]);
    const { user } = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
    const row = (
      await screen.findByRole('heading', {
        level: 4,
        name: t('settingLabels.reco.itemPreferences'),
      })
    ).closest('li') as HTMLElement;
    expect(
      within(row).getByText(t('settingsPage.pageValue.recommendations', { count: 1 })),
    ).toBeVisible();
    await user.click(
      within(row).getByRole('link', { name: t('settingsPage.openPage.recommendations') }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: t('recoPage.title') }),
    ).toBeVisible();
    expect(await screen.findByText(t('recoPage.readOnly'))).toBeVisible();
    expect(screen.queryByRole('button', { name: t('recoPage.rules.add') })).toBeNull();
    expect(screen.queryByRole('group', { name: /Actions for/ })).toBeNull();
  });
});

describe('[REC-009] pinned, boosted and blocked dishes', () => {
  it('pins a dish, changes how another is suggested and removes a third', async () => {
    const start = { [IDS.tikka]: 'BOOST', [IDS.jamun]: 'BLOCK' };
    const fake = recoServer(undefined, [withPreferences(start), withPreferences(start)]);
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const featured = within(
      await screen.findByRole('list', { name: t('recoPage.featured.title') }),
    );
    expect(featured.getByText(t('recoPage.featured.preference.BOOST'))).toBeVisible();
    await expectNoAxeViolations(container);

    const form = within(screen.getByRole('form', { name: t('recoPage.featured.add') }));
    // Dishes already chosen are not offered again.
    expect(form.queryByRole('option', { name: 'Paneer Tikka' })).toBeNull();
    await user.selectOptions(
      form.getByRole('combobox', { name: t('recoPage.featured.dish') }),
      'Dal Makhani',
    );
    await user.click(form.getByRole('button', { name: t('recoPage.featured.add') }));
    await waitFor(() => {
      expect(fake.callsTo('PUT', PREFERENCES)[0]?.body).toEqual({
        value: { ...start, [IDS.dal]: 'PIN' },
      });
    });

    await user.selectOptions(
      featured.getByRole('combobox', {
        name: t('recoPage.featured.howFor', { name: 'Paneer Tikka' }),
      }),
      t('recoPage.featured.choice.PIN'),
    );
    await waitFor(() => {
      expect(fake.callsTo('PUT', PREFERENCES)[1]?.body).toEqual({
        value: { [IDS.tikka]: 'PIN', [IDS.jamun]: 'BLOCK' },
      });
    });
    await user.click(
      featured.getByRole('button', {
        name: t('recoPage.featured.removeFor', { name: 'Gulab Jamun' }),
      }),
    );
    await waitFor(() => {
      expect(fake.callsTo('PUT', PREFERENCES)[2]?.body).toEqual({
        value: { [IDS.tikka]: 'BOOST' },
      });
    });
  });
});

describe('[REC-003] what the restaurant’s orders taught the engine', () => {
  it('says nothing is learned until there are enough orders', async () => {
    await renderConsole({ fake: recoServer(), path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('recoPage.learned.never', { minOrders: 300 }))).toBeVisible();
  });

  it('shows the strongest pairings in plain words, and learns again on request', async () => {
    const fake = recoServer()
      .on('GET', LEARNED, () => ({ status: 200, body: LEARNT }))
      .on('POST', `${LEARNED}/run`, () => ({ status: 200, body: LEARNT }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const pairs = within(await screen.findByRole('list', { name: t('recoPage.learned.title') }));
    expect(
      pairs.getByText(t('recoPage.learned.pair', { from: 'Paneer Tikka', to: 'Dal Makhani' })),
    ).toBeVisible();
    expect(
      pairs.getByText(t('recoPage.learned.strength', { confidence: 62, lift: '1.8' })),
    ).toBeVisible();
    expect(screen.getByText(/from 4,210 orders/)).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: t('recoPage.learned.run') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', `${LEARNED}/run`)).toHaveLength(1);
    });
    expect(await screen.findByText(t('recoPage.learned.ran'))).toBeVisible();
  });
});
