import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../internal/cx.js';
import { DIGITS, isButtonActivation, Keypad, type KeypadKey } from '../internal/Keypad.js';
import { useUiStrings } from '../strings.js';
import { Icon } from './Icon.js';

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

export interface PinPadProps {
  /** Called with the entered PIN. The pad clears itself straight after, so a retry starts empty. */
  onComplete: (pin: string) => void;
  /**
   * Digits in the PIN: 4 by default, 6 when the owner requires it (AUTH-001). Comes from the
   * settings registry, so the pad accepts any length from 4 to 8.
   */
  length?: number;
  /** Submit as soon as the last digit is entered (default). Otherwise a submit key is shown. */
  autoSubmit?: boolean;
  /** Accessible name, e.g. "Enter your PIN" or "Manager PIN". Defaults to the generic string. */
  label?: string;
  /** Plain-language error from the last attempt (e.g. wrong PIN, try again). */
  error?: string | null;
  /** Blocks input while the PIN is being checked. */
  busy?: boolean;
  disabled?: boolean;
  /** Focus the pad on mount so a physical keyboard works immediately. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * The one PIN pad used for staff login and manager overrides everywhere (AUTH-004). Digits are
 * never rendered or announced (AUTH-002): the screen shows filled dots and screen readers hear
 * "2 of 4 digits entered". Works by touch, mouse, on-screen keys with Tab + Enter/Space, and typing
 * on a physical keyboard (digits, Backspace, Escape or Delete to clear, Enter to submit).
 */
export function PinPad({
  onComplete,
  length = MIN_PIN_LENGTH,
  autoSubmit = true,
  label,
  error,
  busy = false,
  disabled = false,
  autoFocus = false,
  className,
}: PinPadProps) {
  if (!Number.isInteger(length) || length < MIN_PIN_LENGTH || length > MAX_PIN_LENGTH) {
    throw new RangeError(
      `PIN length must be a whole number from ${String(MIN_PIN_LENGTH)} to ${String(MAX_PIN_LENGTH)}.`,
    );
  }
  const strings = useUiStrings().pinPad;
  const [digits, setDigits] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const inactive = busy || disabled;

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);

  const submit = (pin: string) => {
    setDigits('');
    onComplete(pin);
  };

  const press = (id: string) => {
    if (inactive) return;
    if (id === 'backspace') {
      setDigits(digits.slice(0, -1));
    } else if (id === 'clear') {
      setDigits('');
    } else if (id === 'submit') {
      if (digits.length === length) submit(digits);
    } else if (/^\d$/.test(id) && digits.length < length) {
      const next = digits + id;
      if (autoSubmit && next.length === length) submit(next);
      else setDigits(next);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isButtonActivation(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    const id = /^\d$/.test(event.key)
      ? event.key
      : { Backspace: 'backspace', Delete: 'clear', Escape: 'clear', Enter: 'submit' }[event.key];
    if (id === undefined) return;
    event.preventDefault();
    press(id);
  };

  const keys: KeypadKey[] = [
    ...DIGITS.map((digit) => ({ id: digit, content: digit })),
    { id: 'clear', content: strings.clear, variant: 'action' },
    { id: '0', content: '0' },
    {
      id: 'backspace',
      content: <Icon name="backspace" />,
      label: strings.backspace,
      variant: 'action',
      disabled: digits.length === 0,
    },
  ];
  if (!autoSubmit) {
    keys.push({
      id: 'submit',
      content: (
        <>
          <Icon name="check" /> {strings.submit}
        </>
      ),
      variant: 'submit',
      wide: true,
      disabled: digits.length !== length,
    });
  }

  return (
    // The group takes focus so a physical keyboard can type into it; each key is also a button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <div
      ref={rootRef}
      role="group"
      aria-label={label ?? strings.label}
      aria-describedby={error ? errorId : undefined}
      aria-busy={busy || undefined}
      aria-disabled={disabled || undefined}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard typing target
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cx('rp-pin-pad', className)}
    >
      <div className="rp-pin-pad__dots" aria-hidden="true" data-invalid={error ? true : undefined}>
        {Array.from({ length }, (_, index) => (
          <span key={index} className="rp-pin-pad__dot" data-filled={index < digits.length} />
        ))}
      </div>
      <p className="rp-visually-hidden" aria-live="polite" aria-atomic="true">
        {strings.progress(digits.length, length)}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="rp-pin-pad__error">
          <Icon name="error" /> {error}
        </p>
      ) : null}
      <Keypad keys={keys} disabled={inactive} onKey={press} />
    </div>
  );
}
