import type { RemoteSettingDefinition, RemoteSettingValues } from '@rp/contracts/control-plane';

/** The editor's text per key: '' keeps the default; 'true'/'false' for a switch; digits. */
export type RemoteDraft = Readonly<Record<string, string>>;

export function draftOf(
  definitions: readonly RemoteSettingDefinition[],
  values: RemoteSettingValues,
): RemoteDraft {
  return Object.fromEntries(
    definitions.map((definition) => {
      const value = values[definition.key];
      return [
        definition.key,
        typeof value === 'boolean' || typeof value === 'number' ? String(value) : '',
      ];
    }),
  );
}

/**
 * The draft as values to save, or the keys whose text is not a value the setting allows (a whole
 * number outside its limits, say). Empty text leaves the key out, so it keeps the default.
 */
export function valuesOf(
  definitions: readonly RemoteSettingDefinition[],
  draft: RemoteDraft,
): { values: RemoteSettingValues; invalid: string[] } {
  const values: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const definition of definitions) {
    const text = (draft[definition.key] ?? '').trim();
    if (text === '') continue;
    if (definition.kind === 'BOOLEAN') {
      values[definition.key] = text === 'true';
      continue;
    }
    const number = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (
      Number.isNaN(number) ||
      (definition.min !== null && number < definition.min) ||
      (definition.max !== null && number > definition.max)
    ) {
      invalid.push(definition.key);
    } else {
      values[definition.key] = number;
    }
  }
  return { values, invalid };
}
