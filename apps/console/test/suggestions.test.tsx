import type {
  MenuSnapshot,
  RecommendationPreferenceView,
  RecommendationRuleRequest,
  RecommendationRuleView,
  RecommendationView,
} from '@rp/contracts';
import { IDS, MENU } from '@rp/ordering/testing';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FakeServer, RecordedCall } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

const RULE_A = '0199a0e0-0000-7000-8000-0000000000a1';
const RULE_B = '0199a0e0-0000-7000-8000-0000000000a2';
const NEW_RULE = '0199a0e0-0000-7000-8000-0000000000a3';
const UPDATED = '2026-10-05T08:00:00.000Z';

/** The fixture menu, with every dish on the tablet so the preview can show it. */
const menu: MenuSnapshot = {
  ...MENU,
  items: MENU.items.map((item) => ({
    ...item,
    channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    stockCount: null,
  })),
};

const ruleView = (
  id: string,
  request: RecommendationRuleRequest,
  archivedAt: string | null = null,
): RecommendationRuleView => ({
  id,
  ...request,
  archivedAt,
  createdAt: UPDATED,
  updatedAt: UPDATED,
});

const tikkaRule: RecommendationRuleRequest = {
  when: { kind: 'ITEM', itemId: IDS.tikka },
  suggest: { kind: 'ITEM', itemId: IDS.jamun },
  priority: 70,
  channels: ['TABLE_TABLET', 'QR'],
  timeWindow: { start: '18:00', end: '23:30' },
  activeFrom: '2026-10-01',
  activeUntil: '2026-10-31',
  label: 'Something sweet',
  active: true,
};

const pausedRule: RecommendationRuleRequest = {
  when: { kind: 'CATEGORY', categoryId: IDS.mains },
  suggest: { kind: 'ITEM', itemId: IDS.rasmalai },
  priority: 20,
  channels: ['WAITER_APP'],
  timeWindow: null,
  activeFrom: null,
  activeUntil: null,
  label: null,
  active: false,
};

interface State {
  menuPublished: boolean;
  rules: RecommendationRuleView[];
  preferences: RecommendationPreferenceView[];
}

/**
 * A fake server holding the rules and the dishes' preferences, with a preview that follows them
 * as the engine does in short: pinned first, then the rules the cart triggers, then two best
 * sellers, never a blocked dish.
 */
function suggestionsServer(initial: Partial<State> = {}): { fake: FakeServer; state: State } {
  const state: State = {
    menuPublished: true,
    rules: [ruleView(RULE_A, tikkaRule), ruleView(RULE_B, pausedRule)],
    preferences: [],
    ...initial,
  };
  const ruleIdOf = (call: RecordedCall) => call.path.split('/')[4] ?? '';
  const preview = (call: RecordedCall) => {
    const query = new URL(call.path, 'http://pos.test').searchParams;
    const cart = query.getAll('cart');
    const kindOf = (itemId: string) =>
      state.preferences.find((entry) => entry.itemId === itemId)?.preference ?? 'NORMAL';
    const chosen: RecommendationView[] = [];
    const take = (suggestion: RecommendationView) => {
      if (kindOf(suggestion.itemId) === 'BLOCK') return;
      if (chosen.some((entry) => entry.itemId === suggestion.itemId)) return;
      chosen.push(suggestion);
    };
    for (const entry of state.preferences.filter((each) => each.preference === 'PIN')) {
      take({
        itemId: entry.itemId,
        layer: 'PINNED',
        reason: { kind: 'PINNED', label: entry.label },
      });
    }
    for (const rule of state.rules.filter((each) => each.active)) {
      if (rule.when.kind === 'ITEM' && cart.includes(rule.when.itemId)) {
        if (rule.suggest.kind === 'ITEM') {
          take({
            itemId: rule.suggest.itemId,
            layer: 'RULE',
            reason: { kind: 'RULE', ruleId: rule.id, label: rule.label, becauseOf: 'Paneer Tikka' },
          });
        }
      }
    }
    for (const itemId of [IDS.dal, IDS.jamun]) {
      take({ itemId, layer: 'BEST_SELLER', reason: { kind: 'BEST_SELLER', daypart: 'LUNCH' } });
    }
    return { status: 200, body: { recommendations: chosen, daypart: 'LUNCH', menuVersion: 1 } };
  };
  const fake = signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/menu', () =>
      state.menuPublished
        ? { status: 200, body: menu }
        : {
            status: 404,
            body: { code: 'MENU_NOT_PUBLISHED', message: 'No menu has been published yet.' },
          },
    )
    .on('GET', '/api/v1/recommendation-rules', () => ({
      status: 200,
      body: { rules: state.rules.filter((rule) => rule.archivedAt === null) },
    }))
    .on('POST', '/api/v1/recommendation-rules', (call) => {
      const created = ruleView(NEW_RULE, call.body as RecommendationRuleRequest);
      state.rules = [...state.rules, created];
      return { status: 201, body: created };
    })
    .on('PUT', `/api/v1/recommendation-rules/${RULE_A}`, (call) => {
      const changed = ruleView(RULE_A, call.body as RecommendationRuleRequest);
      state.rules = state.rules.map((rule) => (rule.id === RULE_A ? changed : rule));
      return { status: 200, body: changed };
    })
    .on('POST', `/api/v1/recommendation-rules/${RULE_A}/archive`, (call) => {
      const id = ruleIdOf(call);
      state.rules = state.rules.map((rule) =>
        rule.id === id ? { ...rule, archivedAt: UPDATED } : rule,
      );
      return { status: 200, body: state.rules.find((rule) => rule.id === id) };
    })
    .on('GET', '/api/v1/recommendation-preferences', () => ({
      status: 200,
      body: { preferences: state.preferences },
    }))
    .on('GET', '/api/v1/recommendations', preview);
  for (const itemId of [IDS.jamun, IDS.dal]) {
    fake.on('PUT', `/api/v1/recommendation-preferences/${itemId}`, (call) => {
      const body = call.body as Pick<RecommendationPreferenceView, 'preference' | 'label'>;
      const view = { itemId, preference: body.preference, label: body.label, updatedAt: UPDATED };
      state.preferences = [
        ...state.preferences.filter((entry) => entry.itemId !== itemId),
        ...(body.preference === 'NORMAL' ? [] : [view]),
      ];
      return { status: 200, body: view };
    });
  }
  return { fake, state };
}

const TIKKA_RULE_TITLE = `If the order has Paneer Tikka, suggest Gulab Jamun`;
const PAUSED_RULE_TITLE = `If the order has ${t('suggestions.rules.anyOf', { category: 'Main Course' })}, suggest Rasmalai`;

/** A name that starts with the given words, matched as they are (they may hold brackets). */
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const openPage = async (fake: FakeServer) => {
  const view = await renderConsole({ fake, path: '/manage/settings', signedIn: 'MANAGER' });
  const pages = await screen.findByRole('navigation', { name: t('settings.pages.label') });
  await view.user.click(within(pages).getByRole('link', { name: t('settings.pages.suggestions') }));
  expect(
    await screen.findByRole('heading', { level: 2, name: t('suggestions.title') }),
  ).toBeVisible();
  return view;
};
const ruleRow = async (title: string) =>
  (await screen.findByRole('heading', { level: 4, name: startsWith(title) })).closest(
    'li',
  ) as HTMLElement;
const sectionOf = (name: string) =>
  screen.getByRole('heading', { level: 3, name }).closest('section')!;
const previewList = () => screen.findByRole('list', { name: t('suggestions.preview.list') });
const previewNames = async () =>
  within(await previewList())
    .getAllByRole('heading', { level: 4 })
    .map((heading) => heading.textContent);
const save = () => screen.getByRole('button', { name: t('settings.dialog.save') });

describe('[REC-002] the Suggestions page', () => {
  it('lists the rules with what they do, their words, priority, hours, dates and places', async () => {
    const { fake } = suggestionsServer();
    const { container } = await openPage(fake);
    const row = await ruleRow(TIKKA_RULE_TITLE);
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      t('suggestions.rules.title'),
      t('suggestions.dishes.title'),
      t('suggestions.preview.title'),
    ]);
    expect(within(row).getByText('Shows “Something sweet”')).toBeVisible();
    expect(within(row).getByText('Priority 70')).toBeVisible();
    expect(within(row).getByText('18:00 to 23:30')).toBeVisible();
    expect(within(row).getByText('1 Oct 2026 to 31 Oct 2026')).toBeVisible();
    expect(within(row).getByText('Table tablet')).toBeVisible();
    expect(within(row).getByText('QR menu')).toBeVisible();
    expect(within(row).queryByText(t('suggestions.rules.row.paused'))).toBeNull();
    const paused = await ruleRow(PAUSED_RULE_TITLE);
    expect(within(paused).getByText(t('suggestions.rules.row.paused'))).toBeVisible();
    expect(within(paused).getByText('Shows “Goes well with Main Course”')).toBeVisible();
    expect(within(paused).getByText(t('suggestions.rules.row.allDay'))).toBeVisible();
    expect(within(paused).getByText(t('suggestions.rules.row.everyDay'))).toBeVisible();
    expect(
      within(sectionOf(t('suggestions.dishes.title'))).getByText(t('suggestions.dishes.none')),
    ).toBeVisible();
    await previewList();
    await expectNoAxeViolations(container);
  });

  it('adds a rule, checked before it is sent', async () => {
    const { fake } = suggestionsServer();
    const { user, container } = await openPage(fake);
    await user.click(await screen.findByRole('button', { name: t('suggestions.rules.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('suggestions.rules.dialog.addTitle'),
    });
    await user.click(save());
    expect(
      within(dialog).getByText(t('suggestions.rules.dialog.problems.whenMissing')),
    ).toBeVisible();
    expect(
      within(dialog).getByText(t('suggestions.rules.dialog.problems.suggestMissing')),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/recommendation-rules')).toHaveLength(0);

    const when = within(dialog).getByRole('group', { name: t('suggestions.rules.dialog.when') });
    await user.selectOptions(
      within(when).getByRole('combobox', { name: t('suggestions.rules.dialog.dish') }),
      'Dal Makhani',
    );
    const suggest = within(dialog).getByRole('group', {
      name: t('suggestions.rules.dialog.suggest'),
    });
    await user.click(
      within(suggest).getByRole('radio', { name: t('suggestions.rules.dialog.kind.CATEGORY') }),
    );
    await user.selectOptions(
      within(suggest).getByRole('combobox', { name: t('suggestions.rules.dialog.category') }),
      'Starters',
    );
    const priority = within(dialog).getByRole('textbox', {
      name: startsWith(t('suggestions.rules.dialog.priority')),
    });
    await user.clear(priority);
    await user.type(priority, '80');
    await user.click(within(dialog).getByRole('checkbox', { name: 'POS' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: t('suggestions.rules.dialog.hoursOnly') }),
    );
    await user.type(within(dialog).getByLabelText(t('settings.dialog.start')), '12:00');
    await user.type(within(dialog).getByLabelText(t('settings.dialog.end')), '15:30');
    await user.type(
      within(dialog).getByRole('textbox', {
        name: startsWith(t('suggestions.rules.dialog.label')),
      }),
      'Start with something light',
    );
    await expectNoAxeViolations(container);
    await user.click(save());

    expect(await screen.findByText(t('suggestions.rules.dialog.saved'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/recommendation-rules').map((call) => call.body)).toEqual([
      {
        when: { kind: 'ITEM', itemId: IDS.dal },
        suggest: { kind: 'CATEGORY', categoryId: IDS.starters },
        priority: 80,
        channels: ['TABLE_TABLET', 'QR', 'WAITER_APP'],
        timeWindow: { start: '12:00', end: '15:30' },
        activeFrom: null,
        activeUntil: null,
        label: 'Start with something light',
        active: true,
      },
    ]);
    const added = await ruleRow(
      `If the order has Dal Makhani, suggest ${t('suggestions.rules.anyOf', { category: 'Starters' })}`,
    );
    expect(within(added).getByText('12:00 to 15:30')).toBeVisible();
  });

  it('changes, pauses, turns on and removes a rule with a reason', async () => {
    const { fake } = suggestionsServer();
    const { user } = await openPage(fake);
    const actions = () =>
      screen.getByRole('group', {
        name: t('suggestions.rules.row.actionsFor', { title: TIKKA_RULE_TITLE }),
      });
    await ruleRow(TIKKA_RULE_TITLE);
    await user.click(
      within(actions()).getByRole('button', { name: t('suggestions.rules.row.edit') }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('suggestions.rules.dialog.editTitle'),
    });
    // Saved unchanged: nothing is sent.
    await user.click(save());
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(fake.callsTo('PUT', `/api/v1/recommendation-rules/${RULE_A}`)).toHaveLength(0);
    expect(dialog).not.toBeInTheDocument();

    await user.click(
      within(actions()).getByRole('button', { name: t('suggestions.rules.row.edit') }),
    );
    const again = await screen.findByRole('dialog', {
      name: t('suggestions.rules.dialog.editTitle'),
    });
    const priority = within(again).getByRole('textbox', {
      name: startsWith(t('suggestions.rules.dialog.priority')),
    });
    expect(priority).toHaveValue('70');
    await user.clear(priority);
    await user.type(priority, '90');
    await user.click(save());
    expect(await screen.findByText(t('suggestions.rules.dialog.saved'))).toBeVisible();
    expect(
      fake.callsTo('PUT', `/api/v1/recommendation-rules/${RULE_A}`).map((call) => call.body),
    ).toEqual([{ ...tikkaRule, priority: 90 }]);

    await user.click(
      within(actions()).getByRole('button', { name: t('suggestions.rules.row.pause') }),
    );
    expect(await screen.findByText(t('suggestions.rules.paused'))).toBeVisible();
    await waitFor(
      () => {
        expect(
          within(actions()).getByRole('button', { name: t('suggestions.rules.row.resume') }),
        ).toBeVisible();
      },
      { timeout: 5_000 },
    );
    expect(fake.callsTo('PUT', `/api/v1/recommendation-rules/${RULE_A}`)[1]?.body).toEqual({
      ...tikkaRule,
      priority: 90,
      active: false,
    });
    await user.click(
      within(actions()).getByRole('button', { name: t('suggestions.rules.row.resume') }),
    );
    expect(await screen.findByText(t('suggestions.rules.resumed'))).toBeVisible();

    await user.click(
      within(actions()).getByRole('button', { name: t('suggestions.rules.row.archive') }),
    );
    const remove = await screen.findByRole('dialog', {
      name: t('suggestions.rules.archiveDialog.title'),
    });
    const confirm = within(remove).getByRole('button', {
      name: t('suggestions.rules.archiveDialog.confirm'),
    });
    expect(confirm).toBeDisabled();
    await user.type(
      within(remove).getByRole('textbox', { name: t('suggestions.rules.archiveDialog.reason') }),
      'Season over',
    );
    await user.click(confirm);
    expect(await screen.findByText(t('suggestions.rules.archived'))).toBeVisible();
    expect(
      fake
        .callsTo('POST', `/api/v1/recommendation-rules/${RULE_A}/archive`)
        .map((call) => call.body),
    ).toEqual([{ reason: 'Season over' }]);
    await waitFor(
      () => {
        expect(screen.queryByRole('heading', { level: 4, name: TIKKA_RULE_TITLE })).toBeNull();
      },
      { timeout: 5_000 },
    );
  });

  it('says when the menu is not published yet, and shows the server’s refusal', async () => {
    const unpublished = suggestionsServer({ menuPublished: false });
    await openPage(unpublished.fake);
    expect(await screen.findByText(t('suggestions.noMenu'))).toBeVisible();
  });

  it('shows the server’s refusal in the rule dialog', async () => {
    const { fake } = suggestionsServer();
    fake.on('POST', '/api/v1/recommendation-rules', () => ({
      status: 422,
      body: {
        code: 'RECOMMENDATION_TARGET_INVALID',
        message: 'A rule can only name items and categories that are on the menu and not archived.',
      },
    }));
    const { user } = await openPage(fake);
    await user.click(await screen.findByRole('button', { name: t('suggestions.rules.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('suggestions.rules.dialog.addTitle'),
    });
    await user.selectOptions(
      within(
        within(dialog).getByRole('group', { name: t('suggestions.rules.dialog.when') }),
      ).getByRole('combobox'),
      'Dal Makhani',
    );
    await user.selectOptions(
      within(
        within(dialog).getByRole('group', { name: t('suggestions.rules.dialog.suggest') }),
      ).getByRole('combobox'),
      'Rasmalai',
    );
    await user.click(save());
    expect(
      await within(dialog).findByText(
        'A rule can only name items and categories that are on the menu and not archived.',
      ),
    ).toBeVisible();
  });
});

describe('[REC-009] pinned, boosted and blocked dishes', () => {
  it('pins a dish with words of its own, blocks it, and puts it back as usual, each audited with a reason', async () => {
    const { fake } = suggestionsServer();
    const { user, container } = await openPage(fake);
    const dishes = () => sectionOf(t('suggestions.dishes.title'));
    await ruleRow(TIKKA_RULE_TITLE);
    await user.click(within(dishes()).getByRole('button', { name: t('suggestions.dishes.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('suggestions.dishes.dialog.addTitle'),
    });
    await user.click(save());
    expect(within(dialog).getByText(t('suggestions.dishes.dialog.dishMissing'))).toBeVisible();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: t('suggestions.dishes.dialog.dish') }),
      'Gulab Jamun',
    );
    // A dish chosen to set up is pinned unless said otherwise.
    expect(
      within(dialog).getByRole('radio', { name: t('suggestions.dishes.dialog.choice.PIN') }),
    ).toBeChecked();
    expect(within(dialog).getByText(t('suggestions.dishes.dialog.pinHint'))).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', {
        name: startsWith(t('suggestions.dishes.dialog.label')),
      }),
      'Made this morning',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: startsWith(t('settings.dialog.reason')) }),
      'Fresh batch',
    );
    await expectNoAxeViolations(container);
    await user.click(save());
    expect(await screen.findByText('Gulab Jamun is pinned.')).toBeVisible();
    expect(
      fake
        .callsTo('PUT', `/api/v1/recommendation-preferences/${IDS.jamun}`)
        .map((call) => call.body),
    ).toEqual([{ preference: 'PIN', label: 'Made this morning', reason: 'Fresh batch' }]);
    const change = await screen.findByRole('button', {
      name: t('suggestions.dishes.changeLabel', { name: 'Gulab Jamun' }),
    });
    const row = change.closest('li') as HTMLElement;
    expect(within(row).getByText(t('suggestions.dishes.preference.PIN'))).toBeVisible();
    expect(within(row).getByText('Shows “Made this morning”')).toBeVisible();

    await user.click(change);
    const block = await screen.findByRole('dialog', {
      name: t('suggestions.dishes.dialog.title', { name: 'Gulab Jamun' }),
    });
    await user.click(
      within(block).getByRole('radio', { name: t('suggestions.dishes.dialog.choice.BLOCK') }),
    );
    // A blocked dish is never shown, so it has no words.
    expect(
      within(block).queryByRole('textbox', {
        name: startsWith(t('suggestions.dishes.dialog.label')),
      }),
    ).toBeNull();
    await user.click(save());
    expect(await screen.findByText('Gulab Jamun is blocked.')).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/recommendation-preferences/${IDS.jamun}`)[1]?.body).toEqual(
      { preference: 'BLOCK', label: null },
    );
    await waitFor(
      () => {
        expect(within(dishes()).getByText(t('suggestions.dishes.preference.BLOCK'))).toBeVisible();
      },
      { timeout: 5_000 },
    );

    await user.click(
      screen.getByRole('button', {
        name: t('suggestions.dishes.changeLabel', { name: 'Gulab Jamun' }),
      }),
    );
    const back = await screen.findByRole('dialog', {
      name: t('suggestions.dishes.dialog.title', { name: 'Gulab Jamun' }),
    });
    await user.click(
      within(back).getByRole('radio', { name: t('suggestions.dishes.dialog.choice.NORMAL') }),
    );
    await user.click(save());
    expect(await screen.findByText('Gulab Jamun is suggested as usual again.')).toBeVisible();
    await waitFor(
      () => {
        expect(within(dishes()).getByText(t('suggestions.dishes.none'))).toBeVisible();
      },
      { timeout: 5_000 },
    );
  });

  it('previews what a table is suggested, on each place and with a dish in the order, read again after a change', async () => {
    const { fake } = suggestionsServer();
    const { user } = await openPage(fake);
    await waitFor(
      async () => {
        expect(await previewNames()).toEqual(['Dal Makhani', 'Gulab Jamun']);
      },
      { timeout: 5_000 },
    );
    const list = await previewList();
    expect(within(list).getAllByText('Bestseller at lunch')).toHaveLength(2);
    expect(within(list).getAllByText(t('suggestions.preview.layer.BEST_SELLER'))).toHaveLength(2);
    const asked = () =>
      fake.calls
        .filter((call) => call.method === 'GET' && call.path.startsWith('/api/v1/recommendations?'))
        .map((call) => new URL(call.path, 'http://pos.test').searchParams);
    expect(asked().at(-1)?.get('channel')).toBe('TABLE_TABLET');
    expect(asked().at(-1)?.get('limit')).toBe('6');

    const preview = sectionOf(t('suggestions.preview.title'));
    await user.selectOptions(
      within(preview).getByRole('combobox', { name: t('suggestions.preview.channel') }),
      'Waiter app',
    );
    await waitFor(() => {
      expect(asked().at(-1)?.get('channel')).toBe('WAITER_APP');
    });
    await user.selectOptions(
      within(preview).getByRole('combobox', { name: t('suggestions.preview.dish') }),
      'Paneer Tikka',
    );
    await waitFor(() => {
      expect(asked().at(-1)?.getAll('cart')).toEqual([IDS.tikka]);
    });
    // Paneer Tikka in the order: the rule's dessert, in the restaurant's words.
    await waitFor(
      async () => {
        expect(await previewNames()).toEqual(['Gulab Jamun', 'Dal Makhani']);
      },
      { timeout: 5_000 },
    );
    expect(within(await previewList()).getByText('Something sweet')).toBeVisible();

    // Pinning Dal Makhani puts it first, as "Our pick".
    await user.click(
      within(sectionOf(t('suggestions.dishes.title'))).getByRole('button', {
        name: t('suggestions.dishes.add'),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('suggestions.dishes.dialog.addTitle'),
    });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: t('suggestions.dishes.dialog.dish') }),
      'Dal Makhani',
    );
    await user.click(save());
    expect(await screen.findByText('Dal Makhani is pinned.')).toBeVisible();
    await waitFor(
      async () => {
        expect(await previewNames()).toEqual(['Dal Makhani', 'Gulab Jamun']);
        expect(within(await previewList()).getByText('Our pick')).toBeVisible();
      },
      { timeout: 5_000 },
    );
    expect(
      within(await previewList()).getByText(t('suggestions.preview.layer.PINNED')),
    ).toBeVisible();
  });
});
