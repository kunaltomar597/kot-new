import type { QrMenuDocument, QrRecommendations } from '@rp/contracts/relay';
import { describe, expect, it } from 'vitest';
import { qrBestSellers, qrSuggestions } from '../src/qr-suggestions.js';
import { IDS, MENU } from '../src/testing/menu-fixture.js';

const RULE = '0199a0e0-0000-7000-8000-000000000201';

function document(recommendations?: Partial<QrRecommendations>): QrMenuDocument {
  return {
    restaurantName: 'Spice Route',
    timeZone: 'Asia/Kolkata',
    instructionMaxLength: 140,
    priceMode: 'TAX_EXCLUSIVE',
    serviceRequests: false,
    menu: { ...MENU, items: MENU.items.map((item) => ({ ...item, channels: ['QR'] })) },
    photos: [],
    ...(recommendations !== undefined && {
      recommendations: {
        rules: [],
        bestSellers: { ALL_DAY: [], BREAKFAST: [], LUNCH: [IDS.rasmalai], EVENING: [], DINNER: [] },
        dayparts: {
          BREAKFAST: { start: '07:00', end: '11:00' },
          LUNCH: { start: '11:00', end: '16:00' },
          EVENING: { start: '16:00', end: '19:00' },
          DINNER: { start: '19:00', end: '04:00' },
        },
        businessDayCutoff: '04:00',
        courseSequence: ['Starters', 'Main Course'],
        preferences: {},
        learned: [],
        ...recommendations,
      },
    }),
  };
}

// 08:00 UTC is 13:30 in Kolkata: lunch.
const LUNCH = new Date('2026-10-02T08:00:00.000Z');

describe('[QR-004] [REC-001] suggestions on the QR page', () => {
  it('suggests nothing before the restaurant publishes its snapshot', () => {
    expect(
      qrSuggestions(document(), { ordered: [], vegOnly: false, now: LUNCH, limit: 4 }),
    ).toEqual({
      suggestions: [],
      daypart: null,
    });
  });

  it('[REC-004] suggests the time of day’s best sellers', () => {
    const { suggestions, daypart } = qrSuggestions(document({}), {
      ordered: [],
      vegOnly: false,
      now: LUNCH,
      limit: 4,
    });
    expect(daypart).toBe('LUNCH');
    expect(suggestions.map((entry) => [entry.itemId, entry.layer])).toEqual([
      [IDS.rasmalai, 'BEST_SELLER'],
    ]);
    expect(qrBestSellers(document({}), LUNCH)).toEqual(new Set([IDS.rasmalai]));
  });

  it('[REC-002] puts the restaurant’s rules first, in their hours', () => {
    const rule = {
      id: RULE,
      priority: 10,
      when: { kind: 'ITEM' as const, itemId: IDS.dal },
      suggest: { kind: 'ITEM' as const, itemId: IDS.tikka },
      timeWindow: { start: '12:00', end: '15:00' },
      activeFrom: null,
      activeUntil: null,
      label: 'Perfect with dal',
    };
    const lunch = qrSuggestions(document({ rules: [rule] }), {
      ordered: [IDS.dal],
      vegOnly: false,
      now: LUNCH,
      limit: 4,
    });
    expect(lunch.suggestions[0]).toMatchObject({ itemId: IDS.tikka, layer: 'RULE' });
    const evening = qrSuggestions(document({ rules: [rule] }), {
      ordered: [IDS.dal],
      vegOnly: false,
      now: new Date('2026-10-02T12:00:00.000Z'),
      limit: 4,
    });
    expect(evening.suggestions.some((entry) => entry.layer === 'RULE')).toBe(false);
  });

  it('[REC-009] never suggests what the restaurant blocked', () => {
    const { suggestions } = qrSuggestions(document({ preferences: { [IDS.rasmalai]: 'BLOCK' } }), {
      ordered: [],
      vegOnly: false,
      now: LUNCH,
      limit: 4,
    });
    expect(suggestions.map((entry) => entry.itemId)).not.toContain(IDS.rasmalai);
  });
});
