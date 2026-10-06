import { describe, expect, it } from 'vitest';
import {
  OrderLineRequest,
  RecommendationPreferenceRequest,
  RecommendationRuleRequest,
  RecommendationsQuery,
  RecommendationsResponse,
  RecordRecommendationEventsRequest,
  TableRecommendationsQuery,
} from '../src/index.js';

const A = '0199a0e0-0000-7000-8000-00000000000a';
const B = '0199a0e0-0000-7000-8000-00000000000b';
const RULE = '0199a0e0-0000-7000-8000-0000000000f1';

describe('[REC-005] asking for suggestions', () => {
  it('takes the cart as a repeated query parameter, once, or not at all', () => {
    expect(RecommendationsQuery.parse({ channel: 'WAITER_APP', cart: [A, B] })).toEqual({
      channel: 'WAITER_APP',
      cart: [A, B],
      vegOnly: false,
      limit: 6,
    });
    expect(TableRecommendationsQuery.parse({ cart: A }).cart).toEqual([A]);
    expect(TableRecommendationsQuery.parse({}).cart).toEqual([]);
    expect(TableRecommendationsQuery.safeParse({ cart: 'paneer' }).success).toBe(false);
  });

  it('reads the veg-only flag and the number of suggestions as a query string carries them', () => {
    expect(TableRecommendationsQuery.parse({ vegOnly: 'true', limit: '3' })).toMatchObject({
      vegOnly: true,
      limit: 3,
    });
    expect(TableRecommendationsQuery.parse({ vegOnly: false }).vegOnly).toBe(false);
    expect(TableRecommendationsQuery.safeParse({ vegOnly: 'yes' }).success).toBe(false);
    expect(TableRecommendationsQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(TableRecommendationsQuery.safeParse({ limit: '21' }).success).toBe(false);
  });

  it('[REC-007] takes nothing about a person, only the table and its cart', () => {
    expect(
      RecommendationsQuery.safeParse({ channel: 'POS', customerPhone: '9876543210' }).success,
    ).toBe(false);
    expect(TableRecommendationsQuery.safeParse({ tableSessionId: A }).success).toBe(false);
  });
});

describe('[REC-008] tracking what was done with a suggestion', () => {
  const event = { kind: 'TAP', itemId: A, layer: 'BEST_SELLER', ruleId: null };

  it('takes impressions, taps and add-to-cart, a rule named only for a rule suggestion', () => {
    const request = { channel: 'TABLE_TABLET', events: [event] };
    expect(RecordRecommendationEventsRequest.safeParse(request).success).toBe(true);
    const ruled = { ...event, kind: 'ADD_TO_CART', layer: 'RULE', ruleId: RULE };
    expect(
      RecordRecommendationEventsRequest.safeParse({ ...request, events: [ruled] }).success,
    ).toBe(true);
    for (const wrong of [
      { ...event, layer: 'RULE' },
      { ...event, ruleId: RULE },
      // The server counts what was ordered from the order itself.
      { ...event, kind: 'ORDERED' },
    ]) {
      expect(
        RecordRecommendationEventsRequest.safeParse({ ...request, events: [wrong] }).success,
      ).toBe(false);
    }
    expect(RecordRecommendationEventsRequest.safeParse({ ...request, events: [] }).success).toBe(
      false,
    );
    const many = Array.from({ length: 51 }, () => event);
    expect(RecordRecommendationEventsRequest.safeParse({ ...request, events: many }).success).toBe(
      false,
    );
  });

  it('lets an order line say which suggestion it came from, never a price (ORD-014)', () => {
    const line = { clientLineId: B, itemId: A, quantity: 1 };
    expect(
      OrderLineRequest.safeParse({ ...line, recommendation: { layer: 'RULE', ruleId: RULE } })
        .success,
    ).toBe(true);
    expect(
      OrderLineRequest.safeParse({ ...line, recommendation: { layer: 'LEARNED', ruleId: RULE } })
        .success,
    ).toBe(false);
    expect(
      OrderLineRequest.safeParse({
        ...line,
        recommendation: { layer: 'BEST_SELLER', ruleId: null, price: 100 },
      }).success,
    ).toBe(false);
  });
});

describe('[REC-002] recommendation rules', () => {
  const rule = {
    when: { kind: 'ITEM', itemId: A },
    suggest: { kind: 'CATEGORY', categoryId: B },
    priority: 50,
    channels: ['TABLE_TABLET', 'WAITER_APP'],
    timeWindow: { start: '18:00', end: '02:00' },
    activeFrom: '2026-10-01',
    activeUntil: '2026-10-31',
    label: 'Perfect with biryani',
    active: true,
  };

  it('takes X and Y, a priority, channels, and optional hours and dates', () => {
    expect(RecommendationRuleRequest.safeParse(rule).success).toBe(true);
    expect(
      RecommendationRuleRequest.safeParse({
        ...rule,
        timeWindow: null,
        activeFrom: null,
        activeUntil: null,
        label: null,
      }).success,
    ).toBe(true);
  });

  it('refuses what cannot work', () => {
    for (const wrong of [
      { ...rule, channels: [] },
      { ...rule, channels: ['QR', 'QR'] },
      { ...rule, priority: 1_001 },
      { ...rule, priority: 2.5 },
      { ...rule, timeWindow: { start: '18:00', end: '18:00' } },
      { ...rule, timeWindow: { start: '25:00', end: '02:00' } },
      { ...rule, activeFrom: '2026-11-01' },
      { ...rule, label: ' ' },
      { ...rule, when: { kind: 'ITEM', categoryId: B } },
      { ...rule, archived: true },
    ]) {
      expect(RecommendationRuleRequest.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});

describe('[REC-009] pinned, boosted and blocked dishes', () => {
  it('pins, boosts or blocks a dish, or puts it back, with words only for a pinned or boosted one', () => {
    for (const request of [
      { preference: 'PIN', label: 'Chef’s special' },
      { preference: 'BOOST', label: null, reason: 'Too much stock' },
      { preference: 'BLOCK', label: null },
      { preference: 'NORMAL', label: null },
    ]) {
      expect(RecommendationPreferenceRequest.safeParse(request).success, request.preference).toBe(
        true,
      );
    }
    expect(
      RecommendationPreferenceRequest.parse({ preference: 'PIN', label: '  Fresh  ' }),
    ).toEqual({ preference: 'PIN', label: 'Fresh' });
    for (const wrong of [
      { preference: 'BLOCK', label: 'Never' },
      { preference: 'NORMAL', label: 'Back' },
      { preference: 'PIN', label: ' ' },
      { preference: 'PIN', label: 'x'.repeat(61) },
      { preference: 'FAVOURITE', label: null },
      { preference: 'PIN' },
      { preference: 'PIN', label: null, reason: '' },
      { preference: 'PIN', label: null, itemId: A },
    ]) {
      expect(RecommendationPreferenceRequest.safeParse(wrong).success, JSON.stringify(wrong)).toBe(
        false,
      );
    }
  });

  it('[REC-006] says a pinned or boosted dish is the restaurant’s pick, and counts it per layer', () => {
    const response = {
      recommendations: [
        { itemId: A, layer: 'PINNED', reason: { kind: 'PINNED', label: 'Chef’s special' } },
        { itemId: B, layer: 'BOOSTED', reason: { kind: 'BOOSTED', label: null } },
      ],
      daypart: 'LUNCH',
      menuVersion: 3,
    };
    expect(RecommendationsResponse.safeParse(response).success).toBe(true);
    expect(
      RecordRecommendationEventsRequest.safeParse({
        channel: 'TABLE_TABLET',
        events: [
          { kind: 'IMPRESSION', itemId: A, layer: 'PINNED', ruleId: null },
          { kind: 'TAP', itemId: B, layer: 'BOOSTED', ruleId: null },
        ],
      }).success,
    ).toBe(true);
    // Only a rule suggestion names a rule.
    expect(
      RecordRecommendationEventsRequest.safeParse({
        channel: 'TABLE_TABLET',
        events: [{ kind: 'TAP', itemId: A, layer: 'PINNED', ruleId: RULE }],
      }).success,
    ).toBe(false);
  });
});
