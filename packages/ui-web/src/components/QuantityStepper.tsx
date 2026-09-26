import { cx } from '../internal/cx.js';
import { Icon } from './Icon.js';
import { IconButton } from './IconButton.js';

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Accessible name of the group, e.g. "Quantity of Dal Makhani". */
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  className?: string;
}

/** − 2 + : changes a quantity with large buttons (NFR-U03); the value is announced as it changes. */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  label,
  decreaseLabel,
  increaseLabel,
  disabled = false,
  className,
}: QuantityStepperProps) {
  return (
    <div role="group" aria-label={label} className={cx('rp-stepper', className)}>
      <IconButton
        label={decreaseLabel}
        icon={<Icon name="minus" />}
        variant="secondary"
        disabled={disabled || value <= min}
        onClick={() => {
          onChange(Math.max(min, value - 1));
        }}
      />
      <output className="rp-stepper__value" aria-live="polite">
        {value}
      </output>
      <IconButton
        label={increaseLabel}
        icon={<Icon name="plus" />}
        variant="secondary"
        disabled={disabled || value >= max}
        onClick={() => {
          onChange(Math.min(max, value + 1));
        }}
      />
    </div>
  );
}
