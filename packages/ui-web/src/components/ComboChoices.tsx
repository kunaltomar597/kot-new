import { ChoiceGroup } from './ChoiceGroup.js';

export interface ComboSlot {
  /** e.g. "Dessert". */
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

export interface ComboChoicesProps {
  slots: readonly ComboSlot[];
  /** The chosen item per slot, in slot order. */
  value: readonly (string | undefined)[];
  onChange: (value: (string | undefined)[]) => void;
  /** e.g. "Choose one". */
  rule: string;
  /** Shown under slots still empty once the person tries to add the combo, e.g. "Choose one". */
  missing?: string;
}

/** The choice slots of a combo (MENU-005): one item per slot, fixed parts need no choice. */
export function ComboChoices({ slots, value, onChange, rule, missing }: ComboChoicesProps) {
  return (
    <div className="rp-item-options">
      {slots.map((slot, index) => (
        <ChoiceGroup
          key={`${String(index)}-${slot.label}`}
          legend={slot.label}
          hint={rule}
          mode="single"
          options={slot.options.map((option) => ({ id: option.id, label: option.name }))}
          value={value[index] === undefined ? [] : [value[index]]}
          onChange={([id]) => {
            const next = slots.map((_, at) => value[at]);
            next[index] = id;
            onChange(next);
          }}
          error={missing !== undefined && value[index] === undefined ? missing : undefined}
        />
      ))}
    </div>
  );
}
