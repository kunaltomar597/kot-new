import {
  type Category,
  type MenuItem,
  RecommendationRuleRequest,
  type RecommendationRuleView,
  type RecommendationTarget,
  SalesChannel,
} from '@rp/contracts';
import type { ItemPreference } from '@rp/domain';

/**
 * The Suggestions page (P4-03c, REC-002, REC-009): what a rule's form holds while it is edited,
 * the request it becomes, and the names of the dishes and categories rules point at.
 */

export const RULE_CHANNELS = SalesChannel.options;
export type RuleChannel = (typeof RULE_CHANNELS)[number];
export type TargetKind = RecommendationTarget['kind'];

export const PRIORITY_MAX = 1_000;
export const LABEL_MAX = 60;

export interface RuleDraft {
  readonly whenKind: TargetKind;
  readonly whenId: string;
  readonly suggestKind: TargetKind;
  readonly suggestId: string;
  readonly label: string;
  readonly priority: string;
  readonly channels: readonly RuleChannel[];
  /** Only between `start` and `end` each day. */
  readonly hours: boolean;
  readonly start: string;
  readonly end: string;
  /** Business dates, both optional. */
  readonly from: string;
  readonly until: string;
  readonly active: boolean;
}

export function ruleDraftOf(rule?: RecommendationRuleView): RuleDraft {
  if (rule === undefined) {
    return {
      whenKind: 'ITEM',
      whenId: '',
      suggestKind: 'ITEM',
      suggestId: '',
      label: '',
      priority: '50',
      channels: RULE_CHANNELS,
      hours: false,
      start: '',
      end: '',
      from: '',
      until: '',
      active: true,
    };
  }
  return {
    whenKind: rule.when.kind,
    whenId: targetId(rule.when),
    suggestKind: rule.suggest.kind,
    suggestId: targetId(rule.suggest),
    label: rule.label ?? '',
    priority: String(rule.priority),
    channels: rule.channels,
    hours: rule.timeWindow !== null,
    start: rule.timeWindow?.start ?? '',
    end: rule.timeWindow?.end ?? '',
    from: rule.activeFrom ?? '',
    until: rule.activeUntil ?? '',
    active: rule.active,
  };
}

export function targetId(target: RecommendationTarget): string {
  return target.kind === 'ITEM' ? target.itemId : target.categoryId;
}

function targetOf(kind: TargetKind, id: string): RecommendationTarget {
  return kind === 'ITEM' ? { kind, itemId: id } : { kind, categoryId: id };
}

export const RULE_PROBLEMS = [
  'WHEN_REQUIRED',
  'SUGGEST_REQUIRED',
  'SAME_DISH',
  'PRIORITY',
  'CHANNELS_REQUIRED',
  'HOURS',
  'DATES',
] as const;
export type RuleProblem = (typeof RULE_PROBLEMS)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What is wrong with a draft, in the order the form shows its fields. */
export function checkRuleDraft(draft: RuleDraft): RuleProblem[] {
  const problems: RuleProblem[] = [];
  if (draft.whenId === '') problems.push('WHEN_REQUIRED');
  if (draft.suggestId === '') problems.push('SUGGEST_REQUIRED');
  if (
    draft.whenId !== '' &&
    draft.whenKind === draft.suggestKind &&
    draft.whenId === draft.suggestId
  ) {
    problems.push('SAME_DISH');
  }
  const priority = draft.priority.trim();
  if (!/^\d{1,4}$/.test(priority) || Number(priority) > PRIORITY_MAX) problems.push('PRIORITY');
  if (draft.channels.length === 0) problems.push('CHANNELS_REQUIRED');
  if (
    draft.hours &&
    (!TIME.test(draft.start) || !TIME.test(draft.end) || draft.start === draft.end)
  ) {
    problems.push('HOURS');
  }
  const from = draft.from.trim();
  const until = draft.until.trim();
  if (
    (from !== '' && !DATE.test(from)) ||
    (until !== '' && !DATE.test(until)) ||
    (from !== '' && until !== '' && from > until)
  ) {
    problems.push('DATES');
  }
  return problems;
}

/** The request a draft without problems stands for, checked like the server will. */
export function ruleRequestOf(draft: RuleDraft): RecommendationRuleRequest | undefined {
  if (checkRuleDraft(draft).length > 0) return undefined;
  const label = draft.label.trim();
  const parsed = RecommendationRuleRequest.safeParse({
    when: targetOf(draft.whenKind, draft.whenId),
    suggest: targetOf(draft.suggestKind, draft.suggestId),
    priority: Number(draft.priority.trim()),
    // In the order the channels are listed, each once.
    channels: RULE_CHANNELS.filter((channel) => draft.channels.includes(channel)),
    timeWindow: draft.hours ? { start: draft.start, end: draft.end } : null,
    activeFrom: draft.from.trim() === '' ? null : draft.from.trim(),
    activeUntil: draft.until.trim() === '' ? null : draft.until.trim(),
    label: label === '' ? null : label.slice(0, LABEL_MAX),
    active: draft.active,
  });
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- names

export interface MenuNames {
  readonly items: ReadonlyMap<string, string>;
  readonly categories: ReadonlyMap<string, string>;
}

export function menuNames(menu: {
  readonly items: readonly Pick<MenuItem, 'id' | 'name'>[];
  readonly categories: readonly Pick<Category, 'id' | 'name'>[];
}): MenuNames {
  return {
    items: new Map(menu.items.map((item) => [item.id, item.name])),
    categories: new Map(menu.categories.map((category) => [category.id, category.name])),
  };
}

/** A target's name, or undefined when it is no longer on the published menu. */
export function targetName(target: RecommendationTarget, names: MenuNames): string | undefined {
  return target.kind === 'ITEM'
    ? names.items.get(target.itemId)
    : names.categories.get(target.categoryId);
}

// ---------------------------------------------------------------- featured dishes (REC-009)

export type Preferences = Readonly<Partial<Record<string, ItemPreference>>>;

export interface FeaturedDish {
  readonly itemId: string;
  /** Undefined when the dish is no longer on the published menu. */
  readonly name: string | undefined;
  readonly preference: ItemPreference;
}

const PREFERENCE_ORDER: Record<ItemPreference, number> = { PIN: 0, BOOST: 1, BLOCK: 2 };

/** The dishes with a preference: pinned, then boosted, then blocked, each by name. */
export function featuredDishes(preferences: Preferences, names: MenuNames): FeaturedDish[] {
  return Object.entries(preferences)
    .flatMap(([itemId, preference]) =>
      preference === undefined ? [] : [{ itemId, name: names.items.get(itemId), preference }],
    )
    .sort(
      (a, b) =>
        PREFERENCE_ORDER[a.preference] - PREFERENCE_ORDER[b.preference] ||
        (a.name ?? '').localeCompare(b.name ?? '', 'en-IN') ||
        a.itemId.localeCompare(b.itemId),
    );
}

/** The preferences with one dish's changed, or removed when `preference` is undefined. */
export function withPreference(
  preferences: Preferences,
  itemId: string,
  preference: ItemPreference | undefined,
): Record<string, ItemPreference> {
  const next: Record<string, ItemPreference> = {};
  for (const [id, chosen] of Object.entries(preferences)) {
    if (id !== itemId && chosen !== undefined) next[id] = chosen;
  }
  if (preference !== undefined) next[itemId] = preference;
  return next;
}
