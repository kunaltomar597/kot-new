import { SETTINGS, type SettingView } from '@rp/contracts';

/** A setting as the server lists it (P4-03a), at its default unless overridden. */
export function settingView(key: string, overrides: Partial<SettingView> = {}): SettingView {
  const definition = SETTINGS.find((setting) => setting.key === key);
  if (definition === undefined) throw new Error(`no setting ${key}`);
  return {
    key,
    value: definition.defaultValue,
    defaultValue: definition.defaultValue,
    isDefault: true,
    scope: definition.scope,
    capability: definition.capability,
    editable: definition.scope === 'RESTAURANT',
    description: definition.description,
    requirements: [...definition.requirements],
    ...(definition.unit !== undefined && { unit: definition.unit }),
    updatedAt: null,
    ...overrides,
  };
}

/** Every catalogue setting as a manager sees it: restaurant ones editable except the Owner's. */
export function settingsAsManager(): { settings: SettingView[] } {
  const owners = new Set(['TAX_AND_INVOICE_SETTINGS', 'DATA_ADMIN', 'LICENSE_MANAGE']);
  return {
    settings: SETTINGS.map((setting) =>
      settingView(setting.key, {
        editable: setting.scope === 'RESTAURANT' && !owners.has(setting.capability),
      }),
    ),
  };
}
