import type { LearnedPair } from './recommendations.js';

/**
 * "Frequently ordered together" (REC-003, P6-02): association rules between pairs of dishes,
 * mined from a restaurant's own baskets by co-occurrence with support, confidence and lift. Pure
 * and integer: rates are basis points and percent, as everywhere (BRD §9.4).
 *
 * For a rule "A → B" over N baskets:
 * - support = baskets with both / N;
 * - confidence = baskets with both / baskets with A;
 * - lift = confidence / (baskets with B / N): above 1, B comes with A more often than alone.
 * A pair of dishes is two rules, one each way, as confidence differs.
 */

/** The `reco.*` thresholds (REC-003 ⚙). */
export interface AssociationThresholds {
  /** `reco.minSupportBp`: share of baskets that hold both, in basis points. */
  readonly minSupportBp: number;
  /** `reco.minConfidenceBp`. */
  readonly minConfidenceBp: number;
  /** `reco.minLiftPercent`: 120 is 1.2×. */
  readonly minLiftPercent: number;
  /** `reco.minOrders`: below this many orders, nothing is learned (too noisy). */
  readonly minOrders: number;
}

export interface LearnedAssociation extends LearnedPair {
  /** Baskets holding both dishes. */
  readonly pairCount: number;
  readonly supportBp: number;
  readonly confidenceBp: number;
  readonly liftPercent: number;
}

export interface LearningResult {
  /** Enough orders to learn from (`minOrders`); when false, `associations` is empty. */
  readonly active: boolean;
  readonly orders: number;
  readonly baskets: number;
  /** Strongest first. */
  readonly associations: LearnedAssociation[];
}

export interface LearningLimits {
  /** At most this many suggestions learned for each dish (the strongest). */
  readonly perItem: number;
  /** At most this many in all (the QR snapshot carries 5,000). */
  readonly total: number;
}

export const DEFAULT_LEARNING_LIMITS: LearningLimits = { perItem: 10, total: 5_000 };

/**
 * Learns the association rules of `baskets` (each the distinct dishes of one table visit or
 * takeaway order). `orders` is how many orders the baskets came from, for `minOrders`.
 * Score: confidence weighted by lift (confidence in basis points × lift / 100), so a strong and
 * surprising pairing ranks above a merely common one.
 */
export function learnAssociations(
  baskets: readonly (readonly string[])[],
  orders: number,
  thresholds: AssociationThresholds,
  limits: LearningLimits = DEFAULT_LEARNING_LIMITS,
): LearningResult {
  const total = baskets.length;
  if (orders < thresholds.minOrders || total === 0) {
    return { active: false, orders, baskets: total, associations: [] };
  }
  const itemCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const basket of baskets) {
    const items = [...new Set(basket)].sort();
    for (const item of items) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const key = `${items[i] ?? ''}\n${items[j] ?? ''}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const found: LearnedAssociation[] = [];
  for (const [key, pairCount] of pairCounts) {
    // Support is the same both ways.
    if (pairCount * 10_000 < thresholds.minSupportBp * total) continue;
    const [first = '', second = ''] = key.split('\n');
    for (const [from, to] of [
      [first, second],
      [second, first],
    ] as const) {
      const fromCount = itemCounts.get(from) ?? 0;
      const toCount = itemCounts.get(to) ?? 0;
      if (pairCount * 10_000 < thresholds.minConfidenceBp * fromCount) continue;
      if (pairCount * total * 100 < thresholds.minLiftPercent * fromCount * toCount) continue;
      const confidenceBp = Math.floor((pairCount * 10_000) / fromCount);
      const liftPercent = Math.floor((pairCount * total * 100) / (fromCount * toCount));
      found.push({
        fromItemId: from,
        toItemId: to,
        pairCount,
        supportBp: Math.floor((pairCount * 10_000) / total),
        confidenceBp,
        liftPercent,
        score: Math.floor((confidenceBp * liftPercent) / 100),
      });
    }
  }

  const strongestFirst = (a: LearnedAssociation, b: LearnedAssociation) =>
    b.score - a.score ||
    b.pairCount - a.pairCount ||
    a.fromItemId.localeCompare(b.fromItemId) ||
    a.toItemId.localeCompare(b.toItemId);
  const perItem = new Map<string, number>();
  const associations = found.sort(strongestFirst).filter((association) => {
    const taken = perItem.get(association.fromItemId) ?? 0;
    if (taken >= limits.perItem) return false;
    perItem.set(association.fromItemId, taken + 1);
    return true;
  });
  return {
    active: true,
    orders,
    baskets: total,
    associations: associations.slice(0, limits.total),
  };
}
