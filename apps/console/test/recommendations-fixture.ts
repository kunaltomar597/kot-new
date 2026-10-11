import type { RecommendationRuleView } from '@rp/contracts';
import { IDS } from '@rp/ordering/testing';

export const RULE_ID = '0199a0e0-0000-7000-8000-0000000000f1';

/** A recommendation rule as the server lists it (P3-04): with Paneer Tikka, suggest Dal Makhani. */
export function ruleView(overrides: Partial<RecommendationRuleView> = {}): RecommendationRuleView {
  return {
    id: RULE_ID,
    when: { kind: 'ITEM', itemId: IDS.tikka },
    suggest: { kind: 'ITEM', itemId: IDS.dal },
    priority: 80,
    channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    timeWindow: null,
    activeFrom: null,
    activeUntil: null,
    label: null,
    active: true,
    archivedAt: null,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}
