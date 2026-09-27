import type { MenuItem, MenuSnapshot } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import { Note, useT } from '@rp/mobile-shell';
import { channelItems, displayPrice, menuCategories, menuNote, visibleItems } from '@rp/ordering';
import { Button, MenuItemCard, TextField } from '@rp/ui-native';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

/**
 * The menu on the phone (WTR-003, MENU-012): categories, search by name, short code or synonym,
 * and the dishes the waiter app sells, each with its price, food type and what is left. Sold-out
 * and switched-off dishes are shown but cannot be chosen (WTR-010), live as availability changes.
 */
export function MenuBrowser({
  menu,
  onChoose,
}: {
  menu: MenuSnapshot;
  onChoose: (item: MenuItem) => void;
}) {
  const t = useT();
  const items = useMemo(() => channelItems(menu, 'WAITER_APP'), [menu]);
  const categories = useMemo(() => menuCategories(menu, items), [menu, items]);
  const [query, setQuery] = useState('');
  const [chosenCategory, setChosenCategory] = useState<string | undefined>();
  // A newer menu may drop the chosen category: show the first one then.
  const categoryId = categories.some((category) => category.id === chosenCategory)
    ? chosenCategory
    : categories[0]?.id;
  const shown = visibleItems(items, query, categoryId);

  if (items.length === 0) return <Note>{t('mobile.order.menuEmpty')}</Note>;

  return (
    <View style={styles.menu}>
      <TextField
        label={t('pos.menu.search')}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        testID="menu-search"
      />
      {query.trim() === '' ? (
        <ScrollView
          horizontal
          accessibilityLabel={t('pos.menu.categories')}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.categories}
          showsHorizontalScrollIndicator={false}
        >
          {categories.map((category) => (
            <Button
              key={category.id}
              variant={category.id === categoryId ? 'primary' : 'secondary'}
              selected={category.id === categoryId}
              onPress={() => {
                setChosenCategory(category.id);
              }}
            >
              {category.name}
            </Button>
          ))}
        </ScrollView>
      ) : null}
      {shown.length === 0 ? (
        <Note>{t('pos.menu.noResults', { query: query.trim() })}</Note>
      ) : (
        <View style={styles.grid}>
          {shown.map((item) => (
            <View key={item.id} style={styles.cell}>
              <MenuItemCard
                name={item.name}
                price={displayPrice(item)}
                foodType={item.foodType}
                foodTypeLabel={t(`pos.menu.foodType.${item.foodType}`)}
                {...menuNote(menu, item, t)}
                onSelect={() => {
                  onChoose(item);
                }}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { gap: spacing[3] },
  categories: { gap: spacing[2] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  cell: { flexBasis: '47%', flexGrow: 1 },
});
