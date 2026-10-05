import { type PrinterView, SETTINGS, type SettingKey, type SettingView } from '@rp/contracts';
import { canonicalJson, grantFor, type Role } from '@rp/domain';
import { RESTAURANT_ID } from './fakes.js';

/** The settings as the server lists them for `role`, with some values changed. */
export function settingViews(
  role: Role,
  changes: Readonly<Partial<Record<SettingKey, unknown>>> = {},
): SettingView[] {
  return SETTINGS.map((definition) => {
    const changed = Object.hasOwn(changes, definition.key);
    const value: unknown = changed ? changes[definition.key] : definition.defaultValue;
    return {
      key: definition.key,
      value,
      defaultValue: definition.defaultValue,
      isDefault: canonicalJson(value) === canonicalJson(definition.defaultValue),
      scope: definition.scope,
      capability: definition.capability,
      editable:
        definition.scope === 'RESTAURANT' && grantFor(role, definition.capability) === 'ALLOW',
      description: definition.description,
      requirements: [...definition.requirements],
      ...(definition.unit !== undefined && { unit: definition.unit }),
      updatedAt: changed ? '2026-10-05T09:00:00.000Z' : null,
    };
  });
}

/** One setting as `settingViews` lists it. */
export function settingView(
  role: Role,
  key: SettingKey,
  changes: Readonly<Partial<Record<SettingKey, unknown>>> = {},
): SettingView {
  const view = settingViews(role, changes).find((each) => each.key === key);
  if (view === undefined) throw new Error(`No setting ${key}`);
  return view;
}

export const COUNTER_PRINTER = '0199a0e0-0000-7000-8000-0000000000e1';
export const KITCHEN_PRINTER = '0199a0e0-0000-7000-8000-0000000000e2';
export const OLD_PRINTER = '0199a0e0-0000-7000-8000-0000000000e3';

export function printer(id: string, name: string, archived = false): PrinterView {
  return {
    id,
    name,
    connection: 'NETWORK',
    host: '192.168.1.50',
    port: 9100,
    paperWidthMm: 80,
    lastSeenAt: null,
    offlineSince: null,
    lastError: null,
    redirectToId: null,
    archivedAt: archived ? '2026-10-01T09:00:00.000Z' : null,
  };
}

export const PRINTERS = [
  printer(COUNTER_PRINTER, 'Counter printer'),
  printer(KITCHEN_PRINTER, 'Kitchen printer'),
  printer(OLD_PRINTER, 'Old printer', true),
];

/** `SettingsChanged` as the live connection delivers it. */
export function settingsChanged(sequence: number, keys: readonly SettingKey[]) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000007${String(sequence).padStart(2, '0')}`,
      type: 'SettingsChanged',
      version: 1,
      occurredAt: '2026-10-05T09:00:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-10-05',
      payload: { keys },
    },
  };
}
