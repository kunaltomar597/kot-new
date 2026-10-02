import type { QrMenuDocument } from '@rp/contracts/relay';
import {
  businessDateOf,
  type Daypart,
  daypartAt,
  type Recommendation,
  recommend,
  timeOfDayOf,
} from '@rp/domain';
import { itemsOffNow } from './line-check.js';

/**
 * The QR page's suggestions (QR-004, REC-001, REC-005): the same engine as every other surface,
 * run in the diner's browser on the snapshot the restaurant published with its menu, for the
 * restaurant's own clock and time of day. Nothing is suggested before a snapshot exists.
 */
export function qrSuggestions(
  document: QrMenuDocument,
  input: {
    /** Dishes in the cart and in the orders sent from this browser. */
    readonly ordered: readonly string[];
    readonly vegOnly: boolean;
    readonly now: Date;
    readonly limit: number;
  },
): { suggestions: Recommendation[]; daypart: Daypart | null } {
  const snapshot = document.recommendations;
  if (snapshot === undefined) return { suggestions: [], daypart: null };
  const { now } = input;
  const time = timeOfDayOf(now, document.timeZone);
  const daypart = daypartAt(time, snapshot.dayparts);
  const ranking = snapshot.bestSellers[daypart ?? 'ALL_DAY'];
  const offNow = itemsOffNow(document.menu, now, document.timeZone);
  const suggestions = recommend({
    items: document.menu.items.map((item) => ({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      foodType: item.foodType,
      available: item.available && !offNow.has(item.id),
      stockCount: item.stockCount,
      channels: item.channels,
      repeatable: item.repeatable,
      archived: item.archived,
    })),
    categories: document.menu.categories,
    rules: snapshot.rules.map((rule) => ({ ...rule, channels: ['QR'] as const })),
    learned: snapshot.learned,
    // A ranking: the engine needs only the order, so the best gets the highest count.
    bestSellers: ranking.map((itemId, index) => ({ itemId, quantity: ranking.length - index })),
    daypart,
    channel: 'QR',
    ordered: input.ordered,
    vegOnly: input.vegOnly,
    time,
    businessDate: businessDateOf(now, {
      cutoff: snapshot.businessDayCutoff,
      timeZone: document.timeZone,
    }),
    courseSequence: snapshot.courseSequence,
    limit: input.limit,
    preferences: snapshot.preferences,
  });
  return { suggestions, daypart };
}

/** The dishes a QR page marks as best sellers now (the filter, TAB-005). */
export function qrBestSellers(document: QrMenuDocument, now: Date): ReadonlySet<string> {
  const snapshot = document.recommendations;
  if (snapshot === undefined) return new Set();
  const daypart = daypartAt(timeOfDayOf(now, document.timeZone), snapshot.dayparts);
  return new Set(snapshot.bestSellers[daypart ?? 'ALL_DAY']);
}
