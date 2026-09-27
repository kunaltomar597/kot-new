import {
  formatRupees,
  type ItemSelection,
  type ModifierGroupDef,
  type SelectionIssue,
  type VariantDef,
} from '@rp/domain';
import { StyleSheet, View } from 'react-native';
import { spacing } from '@rp/design-tokens';
import { ChoiceGroup } from './ChoiceGroup.js';

export interface ItemOptionsLabels {
  /** Legend of the variant choice, e.g. "Size". */
  readonly variant: string;
  /** The option that chooses nothing in an optional single-choice group, e.g. "None". */
  readonly none: string;
  /** The rule of a modifier group, e.g. "Choose 1" or "Optional, up to 3". */
  readonly rule: (group: ModifierGroupDef) => string;
  /** Words for a problem from `validateSelection` (its message is English, for logs). */
  readonly issue?: (issue: SelectionIssue) => string;
}

export interface ItemOptionsProps {
  variants: readonly VariantDef[];
  modifierGroups: readonly ModifierGroupDef[];
  selection: ItemSelection;
  onChange: (selection: ItemSelection) => void;
  labels: ItemOptionsLabels;
  /** From `validateSelection`; shown once the person tries to add the item. */
  issues?: readonly SelectionIssue[];
}

function plus(delta: number): string | undefined {
  if (delta === 0) return undefined;
  return delta > 0 ? `+${formatRupees(delta)}` : formatRupees(delta);
}

/**
 * Variant and modifier choices for one item (MENU-003, MENU-004, MENU-012), the content of the
 * waiter app's item sheet. The rules and prices are `@rp/domain` menu-selection's
 * (`validateSelection`, `unitPriceOf`), the same on every surface and on the server (ORD-014).
 */
export function ItemOptions({
  variants,
  modifierGroups,
  selection,
  onChange,
  labels,
  issues = [],
}: ItemOptionsProps) {
  const chosen = (groupId: string) =>
    selection.modifiers?.find((entry) => entry.groupId === groupId)?.optionIds ?? [];
  const setGroup = (groupId: string, optionIds: readonly string[]) => {
    const others = (selection.modifiers ?? []).filter((entry) => entry.groupId !== groupId);
    onChange({
      ...selection,
      modifiers: optionIds.length === 0 ? others : [...others, { groupId, optionIds }],
    });
  };
  const issueOf = (groupId?: string) => {
    const found = issues.find((issue) =>
      groupId === undefined ? issue.code.startsWith('VARIANT') : issue.groupId === groupId,
    );
    if (found === undefined) return undefined;
    return labels.issue === undefined ? found.message : labels.issue(found);
  };

  return (
    <View style={styles.root}>
      {variants.length > 0 ? (
        <ChoiceGroup
          legend={labels.variant}
          mode="single"
          options={variants.map((variant) => ({
            id: variant.id,
            label: variant.name,
            detail: formatRupees(variant.price),
          }))}
          value={selection.variantId === undefined ? [] : [selection.variantId]}
          onChange={([variantId]) => {
            onChange({ ...selection, ...(variantId !== undefined && { variantId }) });
          }}
          error={issueOf(undefined)}
        />
      ) : null}
      {modifierGroups.map((group) => {
        const single = group.maxSelections === 1;
        const none = `none:${group.id}`;
        const value = chosen(group.id);
        return (
          <ChoiceGroup
            key={group.id}
            legend={group.name}
            hint={labels.rule(group)}
            mode={single ? 'single' : 'multiple'}
            max={group.maxSelections}
            options={[
              ...(single && group.minSelections === 0 ? [{ id: none, label: labels.none }] : []),
              ...group.options.map((option) => ({
                id: option.id,
                label: option.name,
                ...(plus(option.priceDelta) !== undefined && { detail: plus(option.priceDelta) }),
              })),
            ]}
            value={single && group.minSelections === 0 && value.length === 0 ? [none] : value}
            onChange={(next) => {
              setGroup(
                group.id,
                next.filter((id) => id !== none),
              );
            }}
            error={issueOf(group.id)}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[5] },
});
