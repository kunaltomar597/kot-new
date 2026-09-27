import type { RecommendationReason } from '@rp/contracts';
import type { Translator } from '@rp/i18n';

/**
 * The words shown with a suggestion (REC-006, TAB-011): the restaurant's own for a rule that has
 * them ("Cools the spice"), else "Goes well with Chicken Biryani", "Often ordered with …", or
 * "Bestseller at lunch".
 */
export function describeRecommendation(reason: RecommendationReason, t: Translator): string {
  switch (reason.kind) {
    case 'RULE':
      return reason.label ?? t('reco.reason.rule', { dish: reason.becauseOf });
    case 'LEARNED':
      return t('reco.reason.learned', { dish: reason.becauseOf });
    case 'BEST_SELLER':
      return reason.daypart === null
        ? t('reco.reason.bestSeller')
        : t(`reco.reason.bestSellerAt.${reason.daypart}`);
  }
}
