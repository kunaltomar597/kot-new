import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import { addLine, requestLines } from '../src/cart.js';
import { describeRecommendation } from '../src/recommendation-text.js';
import { IDS } from '../src/testing/index.js';

const t = createTranslator();
const RULE = '0199a0e0-0000-7000-8000-0000000000f1';

describe('[REC-006] [TAB-011] the reason shown with a suggestion', () => {
  it('uses the restaurant’s own words for a rule, or says what it goes with', () => {
    expect(
      describeRecommendation(
        { kind: 'RULE', ruleId: RULE, label: 'Cools the spice', becauseOf: 'Chicken Biryani' },
        t,
      ),
    ).toBe('Cools the spice');
    expect(
      describeRecommendation(
        { kind: 'RULE', ruleId: RULE, label: null, becauseOf: 'Butter Chicken' },
        t,
      ),
    ).toBe('Goes well with Butter Chicken');
    expect(describeRecommendation({ kind: 'LEARNED', becauseOf: 'Veg Biryani' }, t)).toBe(
      'Often ordered with Veg Biryani',
    );
  });

  it('calls a best seller one, of the time of day when there is one', () => {
    expect(describeRecommendation({ kind: 'BEST_SELLER', daypart: null }, t)).toBe('Bestseller');
    expect(describeRecommendation({ kind: 'BEST_SELLER', daypart: 'LUNCH' }, t)).toBe(
      'Bestseller at lunch',
    );
    expect(describeRecommendation({ kind: 'BEST_SELLER', daypart: 'EVENING' }, t)).toBe(
      'Bestseller this evening',
    );
  });
});

describe('[REC-008] a cart line added from a suggestion', () => {
  let next = 0;
  const newId = () => `line-${String(++next)}`;
  const jamun = {
    itemId: IDS.jamun,
    name: 'Gulab Jamun',
    summary: '',
    quantity: 1,
    selection: {},
    instructions: '',
    unitPrice: 9_000,
  };
  const suggested = { layer: 'RULE' as const, ruleId: RULE };

  it('sends the suggestion with the line, so the order counts it', () => {
    const lines = addLine([], { ...jamun, recommendation: suggested }, newId);
    expect(requestLines(lines)[0]?.recommendation).toEqual(suggested);
    expect(requestLines(addLine([], jamun, newId))[0]).not.toHaveProperty('recommendation');
  });

  it('keeps the suggestion when the same dish is added again, whichever way came first', () => {
    const fromSuggestion = addLine(
      addLine([], { ...jamun, recommendation: suggested }, newId),
      jamun,
      newId,
    );
    expect(fromSuggestion).toHaveLength(1);
    expect(fromSuggestion[0]).toMatchObject({ quantity: 2, recommendation: suggested });
    const byHandFirst = addLine(
      addLine([], jamun, newId),
      { ...jamun, recommendation: { layer: 'BEST_SELLER', ruleId: null } },
      newId,
    );
    expect(byHandFirst[0]?.recommendation).toEqual({ layer: 'BEST_SELLER', ruleId: null });
  });
});
