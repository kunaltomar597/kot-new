import type { MenuItem, MenuSnapshot } from '@rp/contracts';
import { computeBill, type PriceMode } from '@rp/domain';
import type { CartLine } from './cart.js';
import { displayPrice } from './menu-view.js';

/**
 * The table tablet's menu (P3-03c, TAB-005, TAB-006, TAB-008): fuzzy search over names, synonyms
 * and tags, the diners' filters and sorting, and the cart's estimated taxes. Pure, so the screens
 * stay thin and the rules are tested here.
 */

/** Words a diner adds that say nothing about the dish ("something spicy", "paneer dishes"). */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'dish',
  'food',
  'for',
  'i',
  'in',
  'item',
  'like',
  'me',
  'of',
  'or',
  'please',
  'some',
  'something',
  'the',
  'to',
  'want',
  'with',
]);

/** Query words that mean an attribute rather than a word on the dish. */
const SPICY = new Set(['spicy', 'hot', 'teekha', 'tikha']);
const VEG = new Set(['veg', 'vegetarian']);

function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The words a diner's query looks for. */
export function queryWords(query: string): string[] {
  return normalise(query)
    .split(' ')
    .filter((word) => word !== '' && !STOPWORDS.has(word))
    .map(singular)
    .filter((word) => !STOPWORDS.has(word));
}

/** Edit distance, stopping early once it passes `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** How well one query word matches one word of a dish: 0 not at all, up to 3 exactly. */
function wordScore(query: string, word: string): number {
  if (word === query) return 3;
  if (word.startsWith(query) && query.length >= 2) return 2;
  if (query.length >= 3 && word.includes(query)) return 1.5;
  if (query.length >= 4 && distance(query, word, 1) <= 1) return 1;
  if (query.length >= 7 && distance(query, word, 2) <= 2) return 0.5;
  return 0;
}

function itemWords(item: MenuItem): string[] {
  return normalise([item.name, ...item.synonyms, ...item.tags].join(' '))
    .split(' ')
    .filter((word) => word !== '')
    .map(singular);
}

/** How well a query word matches a dish, attributes included ("spicy", "veg"). */
function matchScore(query: string, item: MenuItem, words: readonly string[]): number {
  const best = Math.max(0, ...words.map((word) => wordScore(query, word)));
  if (best > 0) return best;
  if (SPICY.has(query) && item.spiceLevel >= 2) return 2;
  if (VEG.has(query) && item.foodType === 'VEG') return 1;
  return 0;
}

/**
 * Dishes matching every meaningful word of the query (TAB-006), best first, menu order on a tie.
 * Words are matched exactly, by their start, inside a longer word, or with a typo. "Something
 * spicy" finds dishes tagged spicy (or hot), "paneer dishes" those whose name, synonyms or tags
 * mention paneer. An empty query keeps the dishes as they are.
 */
export function searchMenu(items: readonly MenuItem[], query: string): MenuItem[] {
  const words = queryWords(query);
  if (words.length === 0) return [...items];
  return items
    .map((item, index) => {
      const own = itemWords(item);
      let score = 0;
      for (const word of words) {
        const found = matchScore(word, item, own);
        if (found === 0) return { item, index, score: 0 };
        score += found;
      }
      return { item, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** The diners' filters (TAB-005). */
export const TABLET_FILTERS = ['veg', 'jain', 'spicy', 'bestseller'] as const;
export type TabletFilter = (typeof TABLET_FILTERS)[number];

/** Dishes passing every filter chosen. Jain dishes are those the restaurant tagged Jain. */
export function filterMenu(
  items: readonly MenuItem[],
  filters: ReadonlySet<TabletFilter>,
  bestsellers: ReadonlySet<string>,
): MenuItem[] {
  const tagged = (item: MenuItem, tag: string) =>
    item.tags.some((candidate) => normalise(candidate) === tag);
  return items.filter(
    (item) =>
      (!filters.has('veg') || item.foodType === 'VEG') &&
      (!filters.has('jain') || tagged(item, 'jain')) &&
      (!filters.has('spicy') || item.spiceLevel >= 2 || tagged(item, 'spicy')) &&
      (!filters.has('bestseller') || bestsellers.has(item.id)),
  );
}

/** How the dishes are ordered (TAB-005): as on the menu, or by price. */
export const TABLET_SORTS = ['menu', 'priceLow', 'priceHigh'] as const;
export type TabletSort = (typeof TABLET_SORTS)[number];

export function sortMenu(items: readonly MenuItem[], sort: TabletSort): MenuItem[] {
  if (sort === 'menu') return [...items];
  const direction = sort === 'priceLow' ? 1 : -1;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => direction * (displayPrice(a.item) - displayPrice(b.item)) || a.index - b.index)
    .map((entry) => entry.item);
}

export interface CartEstimate {
  /** What the lines cost at the menu's prices. */
  readonly subtotal: number;
  /** Estimated GST: added on top when prices exclude it, already inside them otherwise. */
  readonly tax: number;
  readonly total: number;
}

/**
 * The review screen's subtotal and estimated taxes (TAB-008), from the menu's tax groups and the
 * restaurant's price mode. The bill itself is computed by the server; this is an estimate.
 */
export function estimateCart(
  lines: readonly CartLine[],
  menu: MenuSnapshot,
  priceMode: PriceMode,
): CartEstimate {
  const items = new Map(menu.items.map((item) => [item.id, item]));
  const billLines = lines.flatMap((line) => {
    const item = items.get(line.itemId);
    return item === undefined
      ? []
      : [
          {
            id: line.clientLineId,
            unitPrice: line.unitPrice,
            quantity: line.quantity,
            taxGroupId: item.taxGroupId,
          },
        ];
  });
  if (billLines.length === 0) return { subtotal: 0, tax: 0, total: 0 };
  const bill = computeBill({
    priceMode,
    lines: billLines,
    taxGroups: menu.taxGroups,
    roundOff: { kind: 'NONE' },
  });
  return { subtotal: bill.subtotal, tax: bill.taxTotal, total: bill.grandTotal };
}
