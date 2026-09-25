import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';

export interface FieldIds {
  readonly inputId: string;
  readonly hintId: string;
  readonly errorId: string;
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** Plain-language message saying what is wrong and how to fix it (NFR-U04). */
  readonly error?: ReactNode;
  readonly required?: boolean;
}

/** `aria-describedby` for a control with optional hint and error. */
export function describedBy(ids: FieldIds, { hint, error }: FieldProps): string | undefined {
  const parts = [hint ? ids.hintId : null, error ? ids.errorId : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Label, hint and error around a form control, shared by TextField and Select. */
export function Field({
  ids,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps & { ids: FieldIds; className?: string; children: ReactNode }) {
  return (
    <div className={className} data-invalid={error ? true : undefined}>
      <label className="rp-field__label" htmlFor={ids.inputId}>
        {label}
        {required ? (
          <span className="rp-field__required" aria-hidden="true">
            {' *'}
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={ids.hintId} className="rp-field__hint">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={ids.errorId} className="rp-field__error">
          <Icon name="error" /> {error}
        </p>
      ) : null}
    </div>
  );
}
