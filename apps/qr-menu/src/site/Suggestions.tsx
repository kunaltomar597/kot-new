'use client';

import type { MenuItem, RecommendationSource } from '@rp/contracts';
import { formatRupees, type Recommendation } from '@rp/domain';
import { describeRecommendation, displayPrice } from '@rp/ordering';
import { Button } from '@rp/ui-web';
import { useT } from './i18n';

/** The suggestion a line comes from, sent with it so it counts as ordered (REC-008). */
export function sourceOf(suggestion: Recommendation): RecommendationSource {
  return {
    layer: suggestion.layer,
    ruleId: suggestion.reason.kind === 'RULE' ? suggestion.reason.ruleId : null,
  };
}

/**
 * A row of suggestions on the QR page (QR-004, REC-006): each dish with why it is suggested, in the
 * restaurant's words when it has them, and one press to add it (or choose its options).
 */
export function Suggestions({
  title,
  suggestions,
  items,
  readOnly,
  needsChoice,
  onPick,
}: {
  title: string;
  suggestions: readonly Recommendation[];
  items: ReadonlyMap<string, MenuItem>;
  readOnly: boolean;
  needsChoice: (item: MenuItem) => boolean;
  onPick: (item: MenuItem, suggestion: Recommendation) => void;
}) {
  const t = useT();
  const shown = suggestions.flatMap((suggestion) => {
    const item = items.get(suggestion.itemId);
    return item === undefined ? [] : [{ suggestion, item }];
  });
  if (shown.length === 0) return null;
  return (
    <section className="qr-suggestions" aria-label={title}>
      <h2 className="qr-section__title">{title}</h2>
      <ul>
        {shown.map(({ suggestion, item }) => (
          <li key={item.id} className="qr-suggestion">
            <p className="qr-suggestion__name">{item.name}</p>
            <p className="qr-muted">{describeRecommendation(suggestion.reason, t)}</p>
            <p className="qr-suggestion__price">{formatRupees(displayPrice(item))}</p>
            <Button
              variant="secondary"
              disabled={readOnly}
              aria-label={
                needsChoice(item)
                  ? t('qrSite.chooseOf', { name: item.name })
                  : t('qrSite.addOf', { name: item.name })
              }
              onClick={() => {
                onPick(item, suggestion);
              }}
            >
              {needsChoice(item) ? t('qrSite.choose') : t('qrSite.add')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
