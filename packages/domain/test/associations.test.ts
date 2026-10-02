import { describe, expect, it } from 'vitest';
import {
  type AssociationThresholds,
  learnAssociations,
  type LearnedAssociation,
} from '../src/associations.js';

/** Our defaults (`reco.*`): 0.5 % support, 20 % confidence, lift 1.2, 300 orders. */
const DEFAULTS: AssociationThresholds = {
  minSupportBp: 50,
  minConfidenceBp: 2_000,
  minLiftPercent: 120,
  minOrders: 300,
};

/** Baskets made of `count` copies of each pattern. */
function baskets(patterns: readonly (readonly [number, readonly string[]])[]): string[][] {
  return patterns.flatMap(([count, items]) => Array.from({ length: count }, () => [...items]));
}

const rule = (result: { associations: LearnedAssociation[] }, from: string, to: string) =>
  result.associations.find((entry) => entry.fromItemId === from && entry.toItemId === to);

/** A small deterministic random source (tests must not depend on Math.random). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('[REC-003] learning what is ordered together', () => {
  // 1,000 visits: biryani mostly with raita; naan with dal; water with everything.
  const visits = baskets([
    [300, ['biryani', 'raita', 'water']],
    [100, ['biryani', 'water']],
    [20, ['raita', 'water']],
    [200, ['naan', 'dal', 'water']],
    [80, ['naan', 'water']],
    [150, ['dal', 'water']],
    [100, ['lassi', 'water']],
    [50, ['tikka']],
  ]);

  it('finds the pairings with their support, confidence and lift', () => {
    const result = learnAssociations(visits, 1_200, DEFAULTS);
    expect(result).toMatchObject({ active: true, orders: 1_200, baskets: 1_000 });
    // Biryani in 400 visits, raita in 320, both in 300.
    expect(rule(result, 'biryani', 'raita')).toEqual({
      fromItemId: 'biryani',
      toItemId: 'raita',
      pairCount: 300,
      supportBp: 3_000,
      confidenceBp: 7_500,
      liftPercent: 234,
      score: 17_550,
    });
    // Raita almost always comes with biryani: a stronger rule that way.
    expect(rule(result, 'raita', 'biryani')).toMatchObject({
      confidenceBp: 9_375,
      liftPercent: 234,
    });
    expect(rule(result, 'naan', 'dal')).toMatchObject({ pairCount: 200, confidenceBp: 7_142 });
  });

  it('leaves out what goes with everything, and what is merely rare', () => {
    const result = learnAssociations(visits, 1_200, DEFAULTS);
    // Water is in 950 of 1,000 visits: no lift, so it says nothing about biryani.
    expect(rule(result, 'biryani', 'water')).toBeUndefined();
    expect(rule(result, 'water', 'biryani')).toBeUndefined();
    // Tikka is only ever alone.
    expect(result.associations.some((entry) => entry.fromItemId === 'tikka')).toBe(false);
    // Strongest first.
    const scores = result.associations.map((entry) => entry.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('honours each threshold', () => {
    const strict = learnAssociations(visits, 1_200, { ...DEFAULTS, minConfidenceBp: 9_000 });
    expect(strict.associations.map((entry) => `${entry.fromItemId}→${entry.toItemId}`)).toEqual([
      'raita→biryani',
    ]);
    const rare = learnAssociations(visits, 1_200, { ...DEFAULTS, minSupportBp: 2_500 });
    expect(rare.associations.every((entry) => entry.pairCount >= 250)).toBe(true);
    const surprising = learnAssociations(visits, 1_200, { ...DEFAULTS, minLiftPercent: 300 });
    expect(surprising.associations).toEqual([]);
  });

  it('learns nothing below the activation volume, to avoid noisy suggestions', () => {
    const result = learnAssociations(visits, 299, DEFAULTS);
    expect(result).toEqual({ active: false, orders: 299, baskets: 1_000, associations: [] });
    expect(learnAssociations([], 500, DEFAULTS).active).toBe(false);
  });

  it('counts a dish once per visit, and keeps the strongest few for each dish', () => {
    const doubled = baskets([
      [200, ['biryani', 'biryani', 'raita']],
      [200, ['dal', 'naan']],
    ]);
    const result = learnAssociations(doubled, 400, DEFAULTS);
    expect(rule(result, 'biryani', 'raita')?.pairCount).toBe(200);
    const capped = learnAssociations(visits, 1_200, DEFAULTS, { perItem: 1, total: 2 });
    expect(capped.associations).toHaveLength(2);
    const froms = capped.associations.map((entry) => entry.fromItemId);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it('gives the same answer for the same baskets, in any order', () => {
    const forward = learnAssociations(visits, 1_200, DEFAULTS);
    const backward = learnAssociations([...visits].reverse(), 1_200, DEFAULTS);
    expect(backward).toEqual(forward);
  });

  it('[NFR-P09] learns 90 days at design capacity in well under a minute', () => {
    // 90 days × 700 visits, 2 to 8 dishes each from a 300-dish menu, with planted pairings.
    const next = random(7);
    const menu = Array.from({ length: 300 }, (_, index) => `dish-${String(index)}`);
    const big: string[][] = [];
    for (let visit = 0; visit < 63_000; visit += 1) {
      const size = 2 + Math.floor(next() * 7);
      const basket = Array.from(
        { length: size },
        () => menu[Math.floor(next() * menu.length)] ?? '',
      );
      if (next() < 0.3) basket.push('dish-1', 'dish-2');
      big.push(basket);
    }
    const started = performance.now();
    const result = learnAssociations(big, 90_000, DEFAULTS);
    const elapsed = performance.now() - started;
    expect(rule(result, 'dish-1', 'dish-2')).toBeDefined();
    expect(result.associations.length).toBeLessThanOrEqual(5_000);
    expect(elapsed).toBeLessThan(20_000);
    // The budget above is the test; the timeout only stops a run that hangs (the default 5 s cut
    // it off on a busy machine before the budget could be checked).
  }, 30_000);
});
