import type { ReactNode } from 'react';

export interface KeypadKey {
  /** Stable id, also the value passed to `onKey` (e.g. "7", "backspace"). */
  readonly id: string;
  readonly content: ReactNode;
  /** Accessible name when `content` is an icon. */
  readonly label?: string;
  readonly disabled?: boolean;
  readonly variant?: 'digit' | 'action' | 'submit';
  /** Spans the full row. */
  readonly wide?: boolean;
}

/**
 * The 3-column key grid shared by PinPad and NumberPad. Keys are real buttons, so they work with
 * touch, mouse, and Tab + Enter/Space; the parent adds physical-keyboard typing.
 */
export function Keypad({
  keys,
  disabled,
  onKey,
}: {
  keys: readonly KeypadKey[];
  disabled: boolean;
  onKey: (id: string) => void;
}) {
  return (
    <div className="rp-keypad">
      {keys.map((key) => (
        <button
          key={key.id}
          type="button"
          className="rp-keypad__key"
          data-variant={key.variant ?? 'digit'}
          data-wide={key.wide ? true : undefined}
          aria-label={key.label}
          disabled={disabled || (key.disabled ?? false)}
          onClick={() => {
            onKey(key.id);
          }}
        >
          {key.content}
        </button>
      ))}
    </div>
  );
}

export const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** True when a key press on a focused button should be left to the button itself. */
export function isButtonActivation(event: { key: string; target: EventTarget }): boolean {
  return (
    (event.key === 'Enter' || event.key === ' ') &&
    event.target instanceof HTMLElement &&
    event.target.tagName === 'BUTTON'
  );
}
