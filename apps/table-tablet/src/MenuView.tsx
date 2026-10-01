import type { MenuItem, MenuSnapshot, RecommendationSource } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import type { SuggestionTracker } from '@rp/mobile-core';
import {
  ItemSheet,
  Note,
  SuggestionRow,
  useDeviceSession,
  useSuggestions,
  useT,
} from '@rp/mobile-shell';
import {
  channelItems,
  filterMenu,
  menuCategories,
  type NewCartLine,
  searchMenu,
  sortMenu,
  TABLET_FILTERS,
  TABLET_SORTS,
  type TabletFilter,
  type TabletSort,
  unavailableReason,
} from '@rp/ordering';
import { Button, ChoiceGroup, SegmentedControl, TextField } from '@rp/ui-native';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { DishCard } from './DishCard';

const ALL = 'all';

/**
 * The menu on the tablet (TAB-005, TAB-006, TAB-012): categories, search, filters and sorting
 * above the dishes; a dish opens its options (TAB-008) and goes into the order. Sold-out dishes
 * update live from the server and cannot be chosen.
 */
export function MenuView({
  menu,
  bestsellers,
  priceMode,
  ordering,
  cartItemIds,
  tracker,
  onAdd,
}: {
  menu: MenuSnapshot;
  bestsellers: ReadonlySet<string>;
  priceMode: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
  /** False while the tablet cannot reach the server (TAB-013). */
  ordering: boolean;
  /** The dishes in the diners' order, which the suggestions go with (TAB-011). */
  cartItemIds: readonly string[];
  tracker: SuggestionTracker;
  /** A dish chosen from a suggestion carries where it came from (REC-008). */
  onAdd: (line: NewCartLine, source?: RecommendationSource) => void;
}) {
  const t = useT();
  const session = useDeviceSession();
  const items = channelItems(menu, 'TABLE_TABLET');
  const categories = menuCategories(menu, items);
  const [category, setCategory] = useState(ALL);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<ReadonlySet<TabletFilter>>(new Set());
  const [sort, setSort] = useState<TabletSort>('menu');
  const [chosen, setChosen] = useState<{ item: MenuItem; source?: RecommendationSource } | null>(
    null,
  );
  const vegOnly = filters.has('veg');
  const forMenu = useSuggestions(
    () =>
      session.api.getTableRecommendations({
        query: { cart: [...cartItemIds], vegOnly, limit: 6 },
      }),
    `${cartItemIds.join(',')}|${String(vegOnly)}`,
    ordering,
  );
  const forItem = useSuggestions(
    () =>
      session.api.getTableRecommendations({
        query: { cart: [...cartItemIds, chosen?.item.id ?? ''], vegOnly, limit: 4 },
      }),
    `${cartItemIds.join(',')}|${chosen?.item.id ?? ''}|${String(vegOnly)}`,
    ordering && chosen !== null,
  );

  const inCategory =
    category === ALL || query.trim() !== ''
      ? items
      : items.filter((item) => item.categoryId === category);
  const shown = sortMenu(filterMenu(searchMenu(inCategory, query), filters, bestsellers), sort);

  return (
    <View style={styles.view} testID="menu-view">
      <Note tone="text">{t('mobile.tablet.ordering.taxNote', { mode: priceMode })}</Note>
      <SuggestionRow
        title={t('reco.row.menu')}
        suggestions={forMenu}
        menu={menu}
        tracker={tracker}
        testID="suggestions-menu"
        onChoose={(item, source) => {
          setChosen({ item, source });
        }}
      />
      <TextField
        label={t('mobile.tablet.ordering.search')}
        hint={t('mobile.tablet.ordering.searchHint')}
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        testID="menu-search"
      />
      <ScrollView horizontal contentContainerStyle={styles.chips}>
        {[{ id: ALL, name: t('mobile.tablet.ordering.all') }, ...categories].map((entry) => (
          <Button
            key={entry.id}
            variant="secondary"
            selected={category === entry.id}
            onPress={() => {
              setCategory(entry.id);
            }}
            testID={`category-${entry.id}`}
          >
            {entry.name}
          </Button>
        ))}
      </ScrollView>
      <ChoiceGroup
        legend={t('mobile.tablet.ordering.filters')}
        mode="multiple"
        options={TABLET_FILTERS.map((filter) => ({
          id: filter,
          label: t(`mobile.tablet.ordering.filter.${filter}`),
        }))}
        value={[...filters]}
        onChange={(value) => {
          setFilters(new Set(value as TabletFilter[]));
        }}
      />
      <SegmentedControl
        label={t('mobile.tablet.ordering.sort')}
        options={TABLET_SORTS.map((id) => ({
          id,
          label: t(`mobile.tablet.ordering.sortBy.${id}`),
        }))}
        value={sort}
        onChange={(id) => {
          setSort(id as TabletSort);
        }}
      />
      {shown.length === 0 ? (
        <Note>{t('mobile.tablet.ordering.noMatch')}</Note>
      ) : (
        <View style={styles.grid}>
          {shown.map((item) => (
            <DishCard
              key={item.id}
              item={item}
              bestseller={bestsellers.has(item.id)}
              soldOut={unavailableReason(item) !== undefined}
              disabled={!ordering}
              onSelect={() => {
                setChosen({ item });
              }}
            />
          ))}
        </View>
      )}
      {chosen !== null && (
        <ItemSheet
          key={chosen.item.id}
          menu={menu}
          item={chosen.item}
          addLabel={t('mobile.tablet.ordering.add')}
          onClose={() => {
            setChosen(null);
          }}
          onAdd={(line) => {
            onAdd(line, chosen.source);
            setChosen(null);
          }}
          extra={
            <SuggestionRow
              title={t('reco.row.item')}
              suggestions={forItem.filter((suggestion) => suggestion.itemId !== chosen.item.id)}
              menu={menu}
              tracker={tracker}
              testID="suggestions-item"
              onChoose={(item, source) => {
                setChosen({ item, source });
              }}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  view: { gap: spacing[3] },
  chips: { gap: spacing[2] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
});
