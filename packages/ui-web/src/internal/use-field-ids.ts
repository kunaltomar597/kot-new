import { useId } from 'react';
import type { FieldIds } from './Field.js';

export function useFieldIds(id: string | undefined): FieldIds {
  const generated = useId();
  const inputId = id ?? generated;
  return { inputId, hintId: `${inputId}-hint`, errorId: `${inputId}-error` };
}
