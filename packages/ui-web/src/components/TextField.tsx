import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../internal/cx.js';
import { describedBy, Field } from '../internal/Field.js';
import { useFieldIds } from '../internal/use-field-ids.js';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Content after the input, e.g. a unit or a clear button. */
  endAdornment?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** Labelled text input with hint and error wired for screen readers (NFR-U05). */
export function TextField({
  label,
  hint,
  error,
  endAdornment,
  id,
  className,
  required,
  ref,
  ...rest
}: TextFieldProps) {
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
      <div className="rp-field__control">
        <input
          {...rest}
          ref={ref}
          id={ids.inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, { label, hint, error })}
          className="rp-field__input"
        />
        {endAdornment ? <span className="rp-field__adornment">{endAdornment}</span> : null}
      </div>
    </Field>
  );
}
