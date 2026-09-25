// Re-exports for stories plus small demo helpers (stories are dev-only, not shipped).
import { parseRupees } from '@rp/domain';

export * from '../src/index.js';

/** Parses a number-pad value to paise, treating incomplete input ("", "12.") leniently. */
export function parseRupeesOrZero(value: string): number {
  try {
    return parseRupees(value.endsWith('.') ? value.slice(0, -1) : value);
  } catch {
    return 0;
  }
}
