import type { ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '../internal/cx.js';
import { describedBy, Field } from '../internal/Field.js';
import { useFieldIds } from '../internal/use-field-ids.js';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * Labelled multi-line text input, like `TextField` (NFR-U05): for lists typed one per line and
 * longer notes.
 */
export function TextArea({
  label,
  hint,
  error,
  id,
  className,
  required,
  rows = 4,
  ref,
  ...rest
}: TextAreaProps) {
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
        <textarea
          {...rest}
          ref={ref}
          id={ids.inputId}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, { label, hint, error })}
          className="rp-field__input rp-field__input--multiline"
        />
      </div>
    </Field>
  );
}
