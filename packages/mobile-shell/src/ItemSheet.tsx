import type { MenuItem, MenuSnapshot } from '@rp/contracts';
import { type ItemSelection, multiply, unitPriceOf, validateSelection } from '@rp/domain';
import {
  comboOf,
  comboSlots,
  issueText,
  type NewCartLine,
  ruleOf,
  selectable,
  summaryOf,
} from '@rp/ordering';
import {
  Button,
  ComboChoices,
  ItemOptions,
  Money,
  QuantityStepper,
  Sheet,
  TextField,
} from '@rp/ui-native';
import { type ReactNode, useState } from 'react';
import { useT } from './context.js';

/** As long as the POS allows (ItemDialog). */
export const INSTRUCTIONS_MAX = 200;

/**
 * A dish's size, add-ons and combo parts, how many, and a note for the kitchen (WTR-003,
 * MENU-003 to MENU-005, MENU-012, TAB-008): the POS item dialog on the phone and the tablet, with
 * the same rules and estimated price from `@rp/domain`. `addLabel` words the button for diners.
 */
export function ItemSheet({
  menu,
  item,
  onClose,
  onAdd,
  addLabel,
  extra,
}: {
  menu: MenuSnapshot;
  item: MenuItem;
  onClose: () => void;
  onAdd: (line: NewCartLine) => void;
  addLabel?: string;
  /** Shown under the dish's choices, e.g. what goes well with it (TAB-011). */
  extra?: ReactNode;
}) {
  const t = useT();
  const def = selectable(menu, item);
  const combo = comboOf(menu, item);
  const slots = combo === undefined ? [] : comboSlots(menu, combo);
  const [selection, setSelection] = useState<ItemSelection>({});
  const [choices, setChoices] = useState<(string | undefined)[]>(slots.map(() => undefined));
  const [quantity, setQuantity] = useState(1);
  const [instructions, setInstructions] = useState('');
  const [tried, setTried] = useState(false);
  const issues = validateSelection(def, selection);
  const unitPrice = issues.length === 0 ? unitPriceOf(def, selection) : undefined;

  const add = () => {
    setTried(true);
    const chosen = choices.filter((choice): choice is string => choice !== undefined);
    if (issues.length > 0 || chosen.length < slots.length) return;
    const comboChoices = slots.length > 0 ? chosen : undefined;
    onAdd({
      itemId: item.id,
      name: item.name,
      summary: summaryOf(menu, item, selection, comboChoices),
      quantity,
      selection,
      ...(comboChoices !== undefined && { comboChoices }),
      instructions: instructions.trim(),
      unitPrice: unitPriceOf(def, selection),
    });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      footer={
        <>
          {unitPrice === undefined ? null : (
            <Money paise={multiply(unitPrice, quantity)} size="lg" strong />
          )}
          <Button size="lg" testID="item-add" onPress={add} style={{ flex: 1 }}>
            {addLabel ?? t('pos.item.add')}
          </Button>
        </>
      }
    >
      <ItemOptions
        variants={def.variants}
        modifierGroups={def.modifierGroups}
        selection={selection}
        onChange={setSelection}
        labels={{
          variant: t('pos.item.variant'),
          none: t('pos.item.none'),
          rule: (group) => ruleOf(group, t),
          issue: (issue) => issueText(issue, def.modifierGroups, t),
        }}
        issues={tried ? issues : []}
      />
      {slots.length > 0 ? (
        <ComboChoices
          slots={slots}
          value={choices}
          onChange={setChoices}
          rule={t('pos.item.comboRule')}
          {...(tried && { missing: t('pos.item.comboMissing') })}
        />
      ) : null}
      <QuantityStepper
        value={quantity}
        onChange={setQuantity}
        label={t('pos.item.quantity')}
        decreaseLabel={t('pos.item.fewer')}
        increaseLabel={t('pos.item.more')}
      />
      <TextField
        label={t('pos.item.instructions')}
        value={instructions}
        onChangeText={setInstructions}
        maxLength={INSTRUCTIONS_MAX}
        multiline
      />
      {extra}
    </Sheet>
  );
}
