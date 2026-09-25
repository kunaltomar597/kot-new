import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';
import { cx } from '../internal/cx.js';
import { describedBy, Field } from '../internal/Field.js';
import { useFieldIds } from '../internal/use-field-ids.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'children' | 'multiple' | 'size'
> {
  label: ReactNode;
  options: readonly SelectOption[];
  /** Text of an empty first option, e.g. "Choose a table". */
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * Single choice from a list. Uses the native select, so the platform picker (touch-friendly on
 * tablets, keyboard type-ahead on desktop) and screen reader support come for free.
 */
export function Select({
  label,
  options,
  placeholder,
  hint,
  error,
  id,
  className,
  required,
  ref,
  ...rest
}: SelectProps) {
  const ids = useFieldIds(id);
  return (
    <Field
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={cx('rp-field', className)}
    >
      <div className="rp-field__control rp-select">
        <select
          {...rest}
          ref={ref}
          id={ids.inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, { label, hint, error })}
          className="rp-field__input rp-select__input"
        >
          {placeholder !== undefined ? (
            <option value="" disabled={required}>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}
