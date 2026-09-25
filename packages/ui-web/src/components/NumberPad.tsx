import type { KeyboardEvent } from 'react';
import { cx } from '../internal/cx.js';
import { DIGITS, isButtonActivation, Keypad, type KeypadKey } from '../internal/Keypad.js';
import { useUiStrings } from '../strings.js';
import { Icon } from './Icon.js';

export interface NumberPadOptions {
  /** Allow one decimal point (for rupee amounts, parsed with `parseRupees` from `@rp/domain`). */
  allowDecimal?: boolean;
  /** Digits allowed after the decimal point; 2 for rupees. */
  maxDecimals?: number;
  /** Maximum characters in the value. */
  maxLength?: number;
}

/**
 * Applies one key to a number-pad value. Pure, so the rules (no leading zeros, one decimal point,
 * limited decimals) are testable on their own. Keys: a digit, ".", "backspace" or "clear".
 */
export function applyNumberPadKey(
  value: string,
  key: string,
  { allowDecimal = false, maxDecimals = 2, maxLength }: NumberPadOptions = {},
): string {
  if (key === 'backspace') return value.slice(0, -1);
  if (key === 'clear') return '';
  if (maxLength !== undefined && value.length >= maxLength) return value;
  if (key === '.') {
    if (!allowDecimal || maxDecimals < 1 || value.includes('.')) return value;
    return value === '' ? '0.' : `${value}.`;
  }
  if (!/^\d$/.test(key)) return value;
  const point = value.indexOf('.');
  if (point >= 0 && value.length - point - 1 >= maxDecimals) return value;
  if (value === '0') return key;
  return value + key;
}

export interface NumberPadProps extends NumberPadOptions {
  /** The current text value; show it in the screen (e.g. in a TextField or with Money). */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Quantity" or "Cash received". */
  label: string;
  /** Optional submit key (e.g. "Add", "Done"); Enter also submits. */
  onSubmit?: () => void;
  submitLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * On-screen number entry for quantities, covers and cash amounts (touch first, NFR-U03). Also
 * accepts typing on a physical keyboard while focus is inside it.
 */
export function NumberPad({
  value,
  onChange,
  label,
  onSubmit,
  submitLabel,
  disabled = false,
  className,
  ...options
}: NumberPadProps) {
  const strings = useUiStrings().numberPad;

  const press = (id: string) => {
    if (disabled) return;
    if (id === 'submit') {
      onSubmit?.();
      return;
    }
    const next = applyNumberPadKey(value, id, options);
    if (next !== value) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isButtonActivation(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    const id = /^\d$/.test(event.key)
      ? event.key
      : {
          '.': '.',
          ',': '.',
          Backspace: 'backspace',
          Delete: 'clear',
          Escape: 'clear',
          Enter: 'submit',
        }[event.key];
    if (id === undefined) return;
    event.preventDefault();
    press(id);
  };

  const clearKey: KeypadKey = { id: 'clear', content: strings.clear, variant: 'action' };
  const keys: KeypadKey[] = [
    ...DIGITS.map((digit) => ({ id: digit, content: digit })),
    options.allowDecimal ? { id: '.', content: '.', label: strings.decimal } : clearKey,
    { id: '0', content: '0' },
    {
      id: 'backspace',
      content: <Icon name="backspace" />,
      label: strings.backspace,
      variant: 'action',
      disabled: value === '',
    },
  ];
  if (options.allowDecimal) keys.push({ ...clearKey, wide: true });
  if (onSubmit && submitLabel) {
    keys.push({ id: 'submit', content: submitLabel, variant: 'submit', wide: true });
  }

  return (
    // The group takes focus so a physical keyboard can type into it; each key is also a button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <div
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard typing target
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cx('rp-number-pad', className)}
    >
      <Keypad keys={keys} disabled={disabled} onKey={press} />
    </div>
  );
}
