'use client';

import type { MenuItem, MenuSnapshot, RecommendationSource } from '@rp/contracts';
import { type ItemSelection, unitPriceOf, validateSelection } from '@rp/domain';
import {
  comboOf,
  comboSlots,
  issueText,
  type NewCartLine,
  ruleOf,
  selectable,
  summaryOf,
} from '@rp/ordering';
import { Button, ComboChoices, Dialog, ItemOptions, QuantityStepper, TextField } from '@rp/ui-web';
import { formatRupees } from '@rp/domain';
import { type ReactNode, useId, useState } from 'react';
import { useT } from './i18n';

/**
 * A dish's size, options and combo parts, how many and a note for the kitchen (MENU-003 to
 * MENU-005). The same rules and estimated price as every other surface (MENU-012).
 */
export function ItemSheet({
  menu,
  item,
  photo,
  instructionMaxLength,
  recommendation,
  onClose,
  onAdd,
}: {
  menu: MenuSnapshot;
  item: MenuItem;
  /** The dish's photo, when it has one (MENU-008). */
  photo?: ReactNode;
  instructionMaxLength: number;
  /** The suggestion it was opened from (REC-008). */
  recommendation?: RecommendationSource | undefined;
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
      ...(recommendation !== undefined && { recommendation }),
    });
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={item.name}
      footer={
        <Button type="submit" form={formId} fullWidth size="lg">
          {t('qrSite.item.addToOrder', {
            price: formatRupees((unitPrice ?? def.basePrice) * quantity),
          })}
        </Button>
      }
    >
      {photo}
      {item.description === undefined ? null : (
        <p className="qr-sheet__description">{item.description}</p>
      )}
      <form
        id={formId}
        className="qr-form"
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
          label={t('qrSite.item.quantity')}
          decreaseLabel={t('qrSite.item.fewer')}
          increaseLabel={t('qrSite.item.more')}
        />
        {instructionMaxLength === 0 ? null : (
          <TextField
            label={t('qrSite.item.instructions')}
            value={instructions}
            maxLength={instructionMaxLength}
            onChange={(event) => {
              setInstructions(event.target.value);
            }}
          />
        )}
      </form>
    </Dialog>
  );
}
