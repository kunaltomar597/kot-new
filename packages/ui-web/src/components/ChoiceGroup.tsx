import { type ReactNode, useId } from 'react';
import { cx } from '../internal/cx.js';
import { Icon } from './Icon.js';

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  /** Shown after the label, e.g. a price change "+₹40.00". */
  readonly detail?: string;
  readonly disabled?: boolean;
}

export interface ChoiceGroupProps {
  legend: ReactNode;
  /** The rule, e.g. "Choose 1" or "Optional, up to 3". */
  hint?: ReactNode;
  /** `single`: radio buttons; `multiple`: checkboxes. */
  mode: 'single' | 'multiple';
  options: readonly ChoiceOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** In `multiple` mode, unchosen options are disabled once this many are chosen. */
  max?: number;
  error?: ReactNode;
  className?: string;
}

/**
 * A labelled set of radio buttons or checkboxes with large touch rows (NFR-U03): variants,
 * modifier groups and combo choices. Native inputs, so keyboard and screen readers work as usual.
 */
export function ChoiceGroup({
  legend,
  hint,
  mode,
  options,
  value,
  onChange,
  max,
  error,
  className,
}: ChoiceGroupProps) {
  const name = useId();
  const hintId = useId();
  const errorId = useId();
  const full = mode === 'multiple' && max !== undefined && value.length >= max;
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset
      className={cx('rp-choice-group', className)}
      aria-describedby={describedBy === '' ? undefined : describedBy}
      aria-invalid={error ? true : undefined}
    >
      <legend className="rp-choice-group__legend">{legend}</legend>
      {hint ? (
        <p id={hintId} className="rp-field__hint">
          {hint}
        </p>
      ) : null}
      <div className="rp-choice-group__options">
        {options.map((option) => {
          const checked = value.includes(option.id);
          return (
            <label
              key={option.id}
              className="rp-choice-group__option"
              data-checked={checked || undefined}
            >
              <input
                type={mode === 'single' ? 'radio' : 'checkbox'}
                name={name}
                value={option.id}
                checked={checked}
                disabled={option.disabled === true || (full && !checked)}
                onChange={() => {
                  if (mode === 'single') onChange([option.id]);
                  else
                    onChange(
                      checked ? value.filter((id) => id !== option.id) : [...value, option.id],
                    );
                }}
              />
              <span className="rp-choice-group__label">{option.label}</span>
              {option.detail === undefined ? null : (
                <span className="rp-choice-group__detail">{option.detail}</span>
              )}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className="rp-field__error">
          <Icon name="error" />
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
