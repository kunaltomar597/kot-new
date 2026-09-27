import type { MenuItem, MenuSnapshot } from '@rp/contracts';
import { type ItemSelection, unitPriceOf, validateSelection } from '@rp/domain';
import {
  Button,
  ComboChoices,
  Dialog,
  ItemOptions,
  Money,
  QuantityStepper,
  TextField,
} from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import {
  comboOf,
  comboSlots,
  issueText,
  type NewCartLine,
  ruleOf,
  selectable,
  summaryOf,
} from '@rp/ordering';

/**
 * Choose a dish's size, modifiers and combo parts, how many and a note for the kitchen
 * (MENU-003 to MENU-005, MENU-012). The rules and the estimated price come from `@rp/domain`.
 */
export function ItemDialog({
  menu,
  item,
  onClose,
  onAdd,
}: {
  menu: MenuSnapshot;
  item: MenuItem;
  onClose: () => void;
  onAdd: (line: NewCartLine) => void;
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
  const formId = useId();
  const issues = validateSelection(def, selection);
  const comboComplete = choices.every((choice) => choice !== undefined);
  const unitPrice = issues.length === 0 ? unitPriceOf(def, selection) : undefined;

  const add = () => {
    setTried(true);
    if (issues.length > 0 || !comboComplete) return;
    // `comboComplete` narrowed `choices` to chosen ids.
    const comboChoices = slots.length > 0 ? choices : undefined;
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
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={item.name}
      footer={
        <>
          {unitPrice === undefined ? null : <Money paise={unitPrice * quantity} size="lg" strong />}
          <Button type="submit" form={formId}>
            {t('pos.item.add')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
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
          maxLength={200}
          onChange={(event) => {
            setInstructions(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}
