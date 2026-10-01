import type {
  MenuItem,
  MenuSnapshot,
  RecommendationSource,
  RecommendationsResponse,
  RecommendationView,
} from '@rp/contracts';
import { fontSize, fontWeight, radius, spacing } from '@rp/design-tokens';
import { formatRupees } from '@rp/domain';
import type { SuggestionTracker } from '@rp/mobile-core';
import { describeRecommendation, displayPrice } from '@rp/ordering';
import { Money, useTheme, weight } from '@rp/ui-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSessionState, useT } from './context.js';

/** Where a suggestion came from, as the cart line and the order carry it (REC-008). */
export function sourceOf(suggestion: RecommendationView): RecommendationSource {
  return {
    layer: suggestion.layer,
    ruleId: suggestion.reason.kind === 'RULE' ? suggestion.reason.ruleId : null,
  };
}

/**
 * A row of suggestions (TAB-011, WTR-011): each dish with its price and why it is suggested
 * ("Goes well with Butter Chicken", "Bestseller"). Showing them counts as an impression, a press
 * as a tap (REC-008); `onChoose` then opens or adds the dish. Nothing shows without suggestions.
 */
export function SuggestionRow({
  title,
  suggestions,
  menu,
  tracker,
  onChoose,
  testID,
}: {
  title: string;
  suggestions: readonly RecommendationView[];
  menu: MenuSnapshot;
  tracker: SuggestionTracker;
  onChoose: (item: MenuItem, source: RecommendationSource) => void;
  testID?: string;
}) {
  const t = useT();
  const { colors } = useTheme();
  const shown = useMemo(() => {
    const items = new Map(menu.items.map((item) => [item.id, item]));
    return suggestions.flatMap((suggestion) => {
      const item = items.get(suggestion.itemId);
      return item === undefined ? [] : [{ suggestion, item }];
    });
  }, [menu, suggestions]);
  /** Each dish counts as shown once while the row is up. */
  const counted = useRef(new Set<string>());
  useEffect(() => {
    for (const { suggestion } of shown) {
      if (counted.current.has(suggestion.itemId)) continue;
      counted.current.add(suggestion.itemId);
      tracker.record({ kind: 'IMPRESSION', itemId: suggestion.itemId, ...sourceOf(suggestion) });
    }
  }, [shown, tracker]);
  if (shown.length === 0) return null;
  return (
    <View style={styles.row} testID={testID}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        {title}
      </Text>
      <ScrollView horizontal contentContainerStyle={styles.cards}>
        {shown.map(({ suggestion, item }) => {
          const reason = describeRecommendation(suggestion.reason, t);
          return (
            <Pressable
              key={item.id}
              testID={`suggestion-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('reco.row.open', {
                name: item.name,
                price: formatRupees(displayPrice(item)),
                reason,
              })}
              onPress={() => {
                tracker.record({ kind: 'TAP', itemId: item.id, ...sourceOf(suggestion) });
                onChoose(item, sourceOf(suggestion));
              }}
              style={({ pressed }) => [
                styles.card,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.accent,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>
                {item.name}
              </Text>
              <Money paise={displayPrice(item)} />
              <Text style={{ color: colors.textMuted }} numberOfLines={2}>
                {reason}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing[2] },
  title: { fontSize: fontSize.lg, fontWeight: weight(fontWeight.semibold) },
  cards: { gap: spacing[2] },
  card: {
    width: 200,
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: 1,
    borderRadius: radius.md,
  },
  name: { fontSize: fontSize.md, fontWeight: weight(fontWeight.semibold) },
});

/**
 * Suggestions for what is on the table now: read again when `key` changes (the cart, the dish
 * open) and when the connection comes back; none while offline or on failure.
 */
export function useSuggestions(
  load: () => Promise<RecommendationsResponse>,
  key: string,
  enabled = true,
): readonly RecommendationView[] {
  const { connection } = useSessionState();
  const [value, setValue] = useState<readonly RecommendationView[]>([]);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    if (!enabled || connection !== 'online') return;
    let active = true;
    latest.current().then(
      (response) => {
        if (active) setValue(response.recommendations);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [key, connection, enabled]);
  return enabled ? value : [];
}
