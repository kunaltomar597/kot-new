import { inTimeWindow } from './business-date.js';
import { DomainError } from './errors.js';

/**
 * The recommendation engine's logic (P3-04, REC-001 to REC-007, NFR-M02): the restaurant's own
 * rules first, then pairings learned from its orders (P6-02), then its best sellers for the time
 * of day, each filtered the same way (REC-005) and each with the reason it is suggested (REC-006).
 * The input is the table's order, never a person's history (REC-007). The server loads the data,
 * counts the best sellers and calls `recommend`; the phones and the tablet only show the result.
 */

export const RECO_CHANNELS = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'] as const;
export type RecoChannel = (typeof RECO_CHANNELS)[number];

export type RecoFoodType = 'VEG' | 'NON_VEG' | 'EGG';

/** Where a suggestion came from, highest precedence first (REC-001). */
export const RECOMMENDATION_LAYERS = ['RULE', 'LEARNED', 'BEST_SELLER'] as const;
export type RecommendationLayer = (typeof RECOMMENDATION_LAYERS)[number];

/** The time-of-day windows best sellers are counted in (REC-004, `reco.dayparts` ⚙). */
export const DAYPARTS = ['BREAKFAST', 'LUNCH', 'EVENING', 'DINNER'] as const;
export type Daypart = (typeof DAYPARTS)[number];

export interface DailyWindow {
  /** 'HH:MM', local time, included. */
  readonly start: string;
  /** 'HH:MM', excluded; before `start` for a window past midnight. */
  readonly end: string;
}

export type Dayparts = Readonly<Record<Daypart, DailyWindow>>;

/** A menu item as the engine needs it (from the published menu with live availability). */
export interface RecoItem {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly foodType: RecoFoodType;
  readonly available: boolean;
  /** Remaining stock when counted; 0 is sold out, null is not counted (MENU-006). */
  readonly stockCount: number | null;
  readonly channels: readonly RecoChannel[];
  /** May be suggested again when already in the order, e.g. drinks and breads (REC-005). */
  readonly repeatable: boolean;
  readonly archived?: boolean;
}

export interface RecoCategory {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/** An item, or a category with its sub-categories, on either side of a rule. */
export type RuleTarget =
  | { readonly kind: 'ITEM'; readonly itemId: string }
  | { readonly kind: 'CATEGORY'; readonly categoryId: string };

/**
 * A manual rule (REC-002): "if the order contains X, suggest Y", with a priority (higher first),
 * the channels it shows on, and optionally hours of the day and business dates it is on.
 */
export interface RecommendationRuleDef {
  readonly id: string;
  readonly priority: number;
  readonly when: RuleTarget;
  readonly suggest: RuleTarget;
  readonly channels: readonly RecoChannel[];
  readonly timeWindow: DailyWindow | null;
  /** Business dates, both included. */
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
  /** The restaurant's own words for why ("Perfect with biryani"); null for the standard reason. */
  readonly label: string | null;
}

/** A pairing learned from the restaurant's orders (P6-02): the higher the score, the stronger. */
export interface LearnedPair {
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly score: number;
}

/** How many of an item were sold in the window counted, for its best-seller rank (REC-004). */
export interface ItemCount {
  readonly itemId: string;
  readonly quantity: number;
}

/** Why an item is suggested, in data; the apps put it in words (REC-006). */
export type RecommendationReason =
  | {
      readonly kind: 'RULE';
      readonly ruleId: string;
      /** The restaurant's own words, when the rule has them. */
      readonly label: string | null;
      /** The item or category in the order that triggered the rule. */
      readonly becauseOf: string;
    }
  | { readonly kind: 'LEARNED'; readonly becauseOf: string }
  | { readonly kind: 'BEST_SELLER'; readonly daypart: Daypart | null };

export interface Recommendation {
  readonly itemId: string;
  readonly layer: RecommendationLayer;
  readonly reason: RecommendationReason;
}

export interface RecommendationInput {
  readonly items: readonly RecoItem[];
  readonly categories: readonly RecoCategory[];
  readonly rules: readonly RecommendationRuleDef[];
  /** Empty until learned pairings exist (P6-02, REC-003). */
  readonly learned?: readonly LearnedPair[];
  /** The best sellers of the time of day now (all day when `daypart` is null), in any order. */
  readonly bestSellers: readonly ItemCount[];
  readonly daypart: Daypart | null;
  readonly channel: RecoChannel;
  /** The items in the table's order so far: sent, waiting for approval and in the cart. */
  readonly ordered: readonly string[];
  /** The table's veg-only filter (REC-005, TAB-005). */
  readonly vegOnly: boolean;
  /** Local time now, 'HH:MM', and the business date, for the rules' hours and dates. */
  readonly time: string;
  readonly businessDate: string;
  /** Course names in serving order (`reco.courseSequence` ⚙). */
  readonly courseSequence: readonly string[];
  readonly limit: number;
}

/** The daypart a local time falls in, or null outside every window (REC-004). */
export function daypartAt(time: string, dayparts: Dayparts): Daypart | null {
  return DAYPARTS.find((daypart) => inTimeWindow(time, dayparts[daypart])) ?? null;
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase('en-IN');

/**
 * Each category's course: its own name, or else its parent's, found in the course sequence, case
 * ignored (REC-005). A category that names no course has none.
 */
export function courseIndexes(
  categories: readonly RecoCategory[],
  courseSequence: readonly string[],
): Map<string, number> {
  const courses = new Map(courseSequence.map((course, index) => [nameKey(course), index]));
  const byId = new Map(categories.map((category) => [category.id, category]));
  const indexes = new Map<string, number>();
  for (const category of categories) {
    const own = courses.get(nameKey(category.name));
    const parent = category.parentId === null ? undefined : byId.get(category.parentId);
    const index = own ?? (parent === undefined ? undefined : courses.get(nameKey(parent.name)));
    if (index !== undefined) indexes.set(category.id, index);
  }
  return indexes;
}

/** Whether a rule is on for this channel, business date and time (REC-002). */
export function ruleIsOn(
  rule: RecommendationRuleDef,
  channel: RecoChannel,
  businessDate: string,
  time: string,
): boolean {
  if (!rule.channels.includes(channel)) return false;
  if (rule.activeFrom !== null && businessDate < rule.activeFrom) return false;
  if (rule.activeUntil !== null && businessDate > rule.activeUntil) return false;
  return rule.timeWindow === null || inTimeWindow(time, rule.timeWindow);
}

/**
 * Up to `limit` suggestions for a table, in order: the rules its order triggers (by priority),
 * then learned pairings, then best sellers; a lower layer fills the places a higher one leaves.
 * Every layer drops what cannot be served on this channel now (not available, sold out, archived),
 * what is in the order already unless repeatable, and anything not veg when the table shows veg
 * only; within a layer the next course comes first (REC-005). No item is suggested twice.
 */
export function recommend(input: RecommendationInput): Recommendation[] {
  if (!Number.isInteger(input.limit) || input.limit < 0) {
    throw new DomainError('INVALID_ARGUMENT', 'The number of suggestions must be a whole number', {
      limit: input.limit,
    });
  }
  const items = new Map(input.items.map((item) => [item.id, item]));
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const courses = courseIndexes(input.categories, input.courseSequence);
  const sold = new Map(input.bestSellers.map((count) => [count.itemId, count.quantity]));

  /** An item's category and the category above it, if any. */
  const categoriesOf = (item: RecoItem): string[] => {
    const parent = categories.get(item.categoryId)?.parentId;
    return parent === null || parent === undefined ? [item.categoryId] : [item.categoryId, parent];
  };

  const ordered = new Set(input.ordered);
  const orderedItems = [...ordered].flatMap((id) => {
    const item = items.get(id);
    return item === undefined ? [] : [item];
  });
  const orderedCategories = new Map<string, string>();
  for (const item of orderedItems) {
    for (const id of categoriesOf(item)) {
      const category = categories.get(id);
      if (category !== undefined && !orderedCategories.has(id)) {
        orderedCategories.set(id, category.name);
      }
    }
  }

  // The course after the furthest one ordered; the first course before anything is ordered.
  const reached = orderedItems.reduce<number>(
    (furthest, item) => Math.max(furthest, courses.get(item.categoryId) ?? -1),
    -1,
  );
  const nextCourse = reached + 1;
  /** 0 for the next course, 1 for a later one or none, 2 for a course already served. */
  const courseRank = (item: RecoItem): number => {
    const course = courses.get(item.categoryId);
    if (course === undefined || course > nextCourse) return 1;
    return course === nextCourse ? 0 : 2;
  };
  const byCourseThenSales = (a: RecoItem, b: RecoItem): number =>
    courseRank(a) - courseRank(b) ||
    (sold.get(b.id) ?? 0) - (sold.get(a.id) ?? 0) ||
    a.name.localeCompare(b.name, 'en-IN') ||
    a.id.localeCompare(b.id);

  const servable = (item: RecoItem): boolean =>
    item.archived !== true &&
    item.available &&
    item.stockCount !== 0 &&
    item.channels.includes(input.channel) &&
    (!input.vegOnly || item.foodType === 'VEG') &&
    (item.repeatable || !ordered.has(item.id));

  const chosen: Recommendation[] = [];
  const taken = new Set<string>();
  const take = (item: RecoItem, layer: RecommendationLayer, reason: RecommendationReason) => {
    if (chosen.length >= input.limit || taken.has(item.id) || !servable(item)) return;
    taken.add(item.id);
    chosen.push({ itemId: item.id, layer, reason });
  };
  const byCategory = new Map<string, RecoItem[]>();
  /** A category's items with its sub-categories', the next course and the best sold first. */
  const inCategory = (categoryId: string): RecoItem[] => {
    let found = byCategory.get(categoryId);
    if (found === undefined) {
      found = input.items
        .filter((item) => categoriesOf(item).includes(categoryId))
        .sort(byCourseThenSales);
      byCategory.set(categoryId, found);
    }
    return found;
  };

  // Layer 1: the restaurant's rules, highest priority first (REC-002).
  const rules = input.rules
    .filter((rule) => ruleIsOn(rule, input.channel, input.businessDate, input.time))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const rule of rules) {
    if (chosen.length >= input.limit) break;
    const becauseOf =
      rule.when.kind === 'ITEM'
        ? ordered.has(rule.when.itemId)
          ? items.get(rule.when.itemId)?.name
          : undefined
        : orderedCategories.get(rule.when.categoryId);
    if (becauseOf === undefined) continue;
    const reason: RecommendationReason = {
      kind: 'RULE',
      ruleId: rule.id,
      label: rule.label,
      becauseOf,
    };
    if (rule.suggest.kind === 'CATEGORY') {
      for (const item of inCategory(rule.suggest.categoryId)) take(item, 'RULE', reason);
    } else {
      const item = items.get(rule.suggest.itemId);
      if (item !== undefined) take(item, 'RULE', reason);
    }
  }

  // Layer 2: pairings learned from this restaurant's orders, strongest first (P6-02).
  const learned = [...(input.learned ?? [])]
    .filter((pair) => ordered.has(pair.fromItemId))
    .sort((a, b) => b.score - a.score);
  for (const pair of learned) {
    if (chosen.length >= input.limit) break;
    const from = items.get(pair.fromItemId);
    const item = items.get(pair.toItemId);
    if (from !== undefined && item !== undefined) {
      take(item, 'LEARNED', { kind: 'LEARNED', becauseOf: from.name });
    }
  }

  // Layer 3: best sellers of the time of day, the next course first (REC-004).
  const bestSellers = input.bestSellers
    .flatMap((count) => {
      const item = items.get(count.itemId);
      return item === undefined || count.quantity <= 0 ? [] : [item];
    })
    .sort(byCourseThenSales);
  for (const item of bestSellers) {
    if (chosen.length >= input.limit) break;
    take(item, 'BEST_SELLER', { kind: 'BEST_SELLER', daypart: input.daypart });
  }
  return chosen;
}
