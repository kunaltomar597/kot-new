/** A well-formed id (UUID v7) that names nothing: requests get past validation to the handlers. */
export const SAMPLE_ID = '0199a0e0-0000-7000-8000-00000000dead';

/**
 * The OpenAPI document as ZAP gets it: every id (`format: uuid`) without an example gets one.
 * ZAP cannot make a value from the ids' pattern and sends an empty one, so `/menu/items/{id}`
 * would be attacked as `/menu/items/` and never reach the code behind it.
 */
export function forZap(document: unknown): unknown {
  if (Array.isArray(document)) return document.map(forZap);
  if (document === null || typeof document !== 'object') return document;
  const entries = Object.entries(document).map(([key, value]) => [key, forZap(value)] as const);
  const copy: Record<string, unknown> = Object.fromEntries(entries);
  if (copy.format === 'uuid' && copy.type === 'string' && copy.example === undefined) {
    copy.example = SAMPLE_ID;
  }
  return copy;
}
