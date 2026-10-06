import type {
  Category,
  MenuItem,
  MenuSnapshot,
  RecommendationPreference,
  RecommendationPreferenceView,
  RecommendationRuleRequest,
  RecommendationRuleView,
  RecommendationTarget,
  RecommendationView,
} from '@rp/contracts';
import { canonicalJson, type RecoChannel } from '@rp/domain';
import type { Translator } from '@rp/i18n';
import { describeRecommendation } from '@rp/ordering';

/**
 * What the Suggestions page shows and edits (P4-03c, REC-002, REC-009, REC-006), kept apart from
 * the screens so it can be tested on its own.
 */

/** Every place a suggestion shows, in the order the dialogs offer them. */
export const CHANNELS: readonly RecoChannel[] = ['TABLE_TABLET', 'QR', 'WAITER_APP', 'POS'];

/** The preferences a dish can have, in the order the dialog offers them. */
export const PREFERENCES: readonly RecommendationPreference[] = ['NORMAL', 'PIN', 'BOOST', 'BLOCK'];

/** The highest priority a rule can have (the contracts' limit). */
export const PRIORITY_MAX = 1_000;

/** A label's length, as the contracts allow. */
export const LABEL_MAX = 60;

/** The dishes a manager can choose: on the published menu and not archived, by name. */
export function dishesOf(menu: MenuSnapshot): MenuItem[] {
  return menu.items
    .filter((item) => !item.archived)
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IN') || a.id.localeCompare(b.id));
}

/** The categories in menu order, each top-level one followed by its sub-categories. */
export function categoriesOf(menu: MenuSnapshot): Category[] {
  const byOrder = (a: Category, b: Category) =>
    a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, 'en-IN');
  const tops = menu.categories.filter((category) => category.parentId === null).sort(byOrder);
  const ordered = tops.flatMap((top) => [
    top,
    ...menu.categories.filter((category) => category.parentId === top.id).sort(byOrder),
  ]);
  // A sub-category whose parent is not published still shows, at the end.
  const listed = new Set(ordered.map((category) => category.id));
  return [...ordered, ...menu.categories.filter((category) => !listed.has(category.id))];
}

/** A category as the dialogs offer it: "Biryani (Mains)" for a sub-category. */
export function categoryChoice(t: Translator, category: Category, menu: MenuSnapshot): string {
  const parent =
    category.parentId === null
      ? undefined
      : menu.categories.find((candidate) => candidate.id === category.parentId);
  return parent === undefined
    ? category.name
    : t('suggestions.rules.dialog.subCategory', { name: category.name, parent: parent.name });
}

const dishName = (menu: MenuSnapshot, itemId: string) =>
  menu.items.find((item) => item.id === itemId)?.name;

const categoryName = (menu: MenuSnapshot, categoryId: string) =>
  menu.categories.find((category) => category.id === categoryId)?.name;

/** A rule's side in words: the dish, "any Mains", or that it is no longer on the menu. */
export function targetText(
  t: Translator,
  target: RecommendationTarget,
  menu: MenuSnapshot,
): string {
  if (target.kind === 'ITEM') {
    return dishName(menu, target.itemId) ?? t('suggestions.rules.goneDish');
  }
  const name = categoryName(menu, target.categoryId);
  return name === undefined
    ? t('suggestions.rules.goneCategory')
    : t('suggestions.rules.anyOf', { category: name });
}

/** "If the order has Chicken Biryani, suggest Raita". */
export function ruleTitle(t: Translator, rule: RecommendationRuleView, menu: MenuSnapshot): string {
  return t('suggestions.rules.row.title', {
    when: targetText(t, rule.when, menu),
    suggest: targetText(t, rule.suggest, menu),
  });
}

/**
 * The words shown with a rule's suggestion (REC-006): the restaurant's own, or "Goes well with" the
 * dish or category ordered, as the tablets show it.
 */
export function ruleReason(
  t: Translator,
  rule: RecommendationRuleView,
  menu: MenuSnapshot,
): string {
  const becauseOf =
    rule.when.kind === 'ITEM'
      ? dishName(menu, rule.when.itemId)
      : categoryName(menu, rule.when.categoryId);
  return rule.label ?? t('reco.reason.rule', { dish: becauseOf ?? '' });
}

/** The hours a rule is on: "All day", "18:00 to 23:30", or a window past midnight. */
export function hoursText(t: Translator, rule: Pick<RecommendationRuleView, 'timeWindow'>): string {
  const window = rule.timeWindow;
  if (window === null) return t('suggestions.rules.row.allDay');
  return t(
    window.end < window.start
      ? 'suggestions.rules.row.hoursOvernight'
      : 'suggestions.rules.row.hours',
    { start: window.start, end: window.end },
  );
}

/** A business date as "1 Oct 2026" (a calendar date, not an instant). */
export function dateText(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** The business dates a rule is on: "Every day", "From 1 Oct 2026", "1 Oct 2026 to 31 Oct 2026". */
export function datesText(
  t: Translator,
  rule: Pick<RecommendationRuleView, 'activeFrom' | 'activeUntil'>,
): string {
  const from = rule.activeFrom === null ? null : dateText(rule.activeFrom, t.locale);
  const until = rule.activeUntil === null ? null : dateText(rule.activeUntil, t.locale);
  if (from !== null && until !== null) return t('suggestions.rules.row.between', { from, until });
  if (from !== null) return t('suggestions.rules.row.from', { from });
  if (until !== null) return t('suggestions.rules.row.until', { until });
  return t('suggestions.rules.row.everyDay');
}

/** The channels of a rule in words, in the order the dialogs offer them. */
export function channelsText(t: Translator, channels: readonly RecoChannel[]): string[] {
  return CHANNELS.filter((channel) => channels.includes(channel)).map((channel) =>
    t(`menuEditor.editor.channel.${channel}`),
  );
}

// ---------------------------------------------------------------- the rule dialog

export type TargetKind = RecommendationTarget['kind'];

export interface RuleForm {
  readonly whenKind: TargetKind;
  readonly whenId: string;
  readonly suggestKind: TargetKind;
  readonly suggestId: string;
  readonly priority: string;
  readonly channels: readonly RecoChannel[];
  readonly hoursOnly: boolean;
  readonly start: string;
  readonly end: string;
  readonly datesOnly: boolean;
  readonly from: string;
  readonly until: string;
  readonly label: string;
  readonly active: boolean;
}

export function emptyRuleForm(): RuleForm {
  return {
    whenKind: 'ITEM',
    whenId: '',
    suggestKind: 'ITEM',
    suggestId: '',
    priority: '50',
    channels: CHANNELS,
    hoursOnly: false,
    start: '',
    end: '',
    datesOnly: false,
    from: '',
    until: '',
    label: '',
    active: true,
  };
}

const idOf = (target: RecommendationTarget) =>
  target.kind === 'ITEM' ? target.itemId : target.categoryId;

export function ruleFormOf(rule: RecommendationRuleView): RuleForm {
  return {
    whenKind: rule.when.kind,
    whenId: idOf(rule.when),
    suggestKind: rule.suggest.kind,
    suggestId: idOf(rule.suggest),
    priority: String(rule.priority),
    channels: CHANNELS.filter((channel) => rule.channels.includes(channel)),
    hoursOnly: rule.timeWindow !== null,
    start: rule.timeWindow?.start ?? '',
    end: rule.timeWindow?.end ?? '',
    datesOnly: rule.activeFrom !== null || rule.activeUntil !== null,
    from: rule.activeFrom ?? '',
    until: rule.activeUntil ?? '',
    label: rule.label ?? '',
    active: rule.active,
  };
}

export type RuleField = 'when' | 'suggest' | 'priority' | 'channels' | 'hours' | 'dates';
export type RuleProblem =
  'whenMissing' | 'suggestMissing' | 'sameDish' | 'priority' | 'channels' | 'hours' | 'dates';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What stops the rule from being saved, by field, as the contracts check it. */
export function checkRule(form: RuleForm): Partial<Record<RuleField, RuleProblem>> {
  const problems: Partial<Record<RuleField, RuleProblem>> = {};
  if (form.whenId === '') problems.when = 'whenMissing';
  if (form.suggestId === '') problems.suggest = 'suggestMissing';
  else if (
    form.whenKind === 'ITEM' &&
    form.suggestKind === 'ITEM' &&
    form.whenId === form.suggestId
  ) {
    problems.suggest = 'sameDish';
  }
  const priority = form.priority.trim();
  if (!/^\d+$/.test(priority) || Number(priority) > PRIORITY_MAX) problems.priority = 'priority';
  if (form.channels.length === 0) problems.channels = 'channels';
  if (
    form.hoursOnly &&
    (!TIME.test(form.start) || !TIME.test(form.end) || form.start === form.end)
  ) {
    problems.hours = 'hours';
  }
  if (form.datesOnly) {
    // One of the two is enough: a rule from a day on, or until a day.
    const valid = (date: string) => date === '' || DATE.test(date);
    if (
      !valid(form.from) ||
      !valid(form.until) ||
      (form.from === '' && form.until === '') ||
      (form.from !== '' && form.until !== '' && form.from > form.until)
    ) {
      problems.dates = 'dates';
    }
  }
  return problems;
}

const targetOf = (kind: TargetKind, id: string): RecommendationTarget =>
  kind === 'ITEM' ? { kind, itemId: id } : { kind, categoryId: id };

/** The request for a checked form. */
export function ruleRequestOf(form: RuleForm): RecommendationRuleRequest {
  const label = form.label.trim();
  return {
    when: targetOf(form.whenKind, form.whenId),
    suggest: targetOf(form.suggestKind, form.suggestId),
    priority: Number(form.priority.trim()),
    channels: CHANNELS.filter((channel) => form.channels.includes(channel)),
    timeWindow: form.hoursOnly ? { start: form.start, end: form.end } : null,
    activeFrom: form.datesOnly && form.from !== '' ? form.from : null,
    activeUntil: form.datesOnly && form.until !== '' ? form.until : null,
    label: label === '' ? null : label,
    active: form.active,
  };
}

/** Whether two requests ask for the same rule, whatever order their channels are in. */
export function sameRuleRequest(
  a: RecommendationRuleRequest,
  b: RecommendationRuleRequest,
): boolean {
  const key = (request: RecommendationRuleRequest) =>
    canonicalJson({
      ...request,
      channels: CHANNELS.filter((channel) => request.channels.includes(channel)),
    });
  return key(a) === key(b);
}

/** A rule as it is, to change one thing (pause or turn on). */
export function requestOfRule(
  rule: RecommendationRuleView,
  changes: Partial<RecommendationRuleRequest> = {},
): RecommendationRuleRequest {
  return {
    when: rule.when,
    suggest: rule.suggest,
    priority: rule.priority,
    channels: rule.channels,
    timeWindow: rule.timeWindow,
    activeFrom: rule.activeFrom,
    activeUntil: rule.activeUntil,
    label: rule.label,
    active: rule.active,
    ...changes,
  };
}

// ---------------------------------------------------------------- dishes and the preview

export interface PreferenceRow {
  readonly preference: RecommendationPreferenceView;
  /** Undefined for a dish not on the published menu (yet). */
  readonly dish: MenuItem | undefined;
  readonly name: string;
}

/** The pinned, boosted and blocked dishes: pinned first, then boosted, then blocked, by name. */
export function preferenceRows(
  t: Translator,
  preferences: readonly RecommendationPreferenceView[],
  menu: MenuSnapshot,
): PreferenceRow[] {
  return preferences
    .filter((entry) => entry.preference !== 'NORMAL')
    .map((preference) => {
      const dish = menu.items.find((item) => item.id === preference.itemId);
      return { preference, dish, name: dish?.name ?? t('suggestions.dishes.unpublished') };
    })
    .sort(
      (a, b) =>
        PREFERENCES.indexOf(a.preference.preference) -
          PREFERENCES.indexOf(b.preference.preference) ||
        a.name.localeCompare(b.name, 'en-IN') ||
        a.preference.itemId.localeCompare(b.preference.itemId),
    );
}

/** A dish's preference, NORMAL when it has none. */
export function preferenceOf(
  preferences: readonly RecommendationPreferenceView[],
  itemId: string,
): { readonly preference: RecommendationPreference; readonly label: string | null } {
  const found = preferences.find((entry) => entry.itemId === itemId);
  return found === undefined
    ? { preference: 'NORMAL', label: null }
    : { preference: found.preference, label: found.label };
}

/** Whether a dish's preference can carry words (pinned or boosted). */
export const takesLabel = (preference: RecommendationPreference): boolean =>
  preference === 'PIN' || preference === 'BOOST';

export interface PreviewRow {
  readonly itemId: string;
  readonly name: string;
  readonly reason: string;
  readonly layer: string;
}

/** A suggestion as the preview lists it: the dish, its reason as the tablets show it, its layer. */
export function previewRow(
  t: Translator,
  suggestion: RecommendationView,
  menu: MenuSnapshot,
): PreviewRow {
  return {
    itemId: suggestion.itemId,
    name: dishName(menu, suggestion.itemId) ?? t('suggestions.dishes.unpublished'),
    reason: describeRecommendation(suggestion.reason, t),
    layer: t(`suggestions.preview.layer.${suggestion.layer}`),
  };
}
