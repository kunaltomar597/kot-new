import type { DeviceSummary } from '@rp/contracts';
import { actorGrant, type Capability, type Grant, type Role } from '@rp/domain';

/** The console's three modes (MGR-001, KDS-001); each is a route prefix. */
export const MODES = ['pos', 'kds', 'manage'] as const;
export type Mode = (typeof MODES)[number];

/** The signed-in person as screens see them: their role and their custom role's extras. */
export interface Person {
  readonly role: Role;
  readonly capabilities?: readonly Capability[];
}

/**
 * The grant a person has (BRD §4.2 with their custom role, AUTH-012), for deciding what to show.
 * The server decides again on every call (AUTH-010).
 */
export function grantOf(person: Person, capability: Capability): Grant {
  return actorGrant(
    { role: person.role, extraCapabilities: person.capabilities ?? [] },
    capability,
  );
}

/** What opens each mode (never DENY for any of them); the dashboard has several areas. */
const MODE_CAPABILITIES: Readonly<Record<Mode, readonly Capability[]>> = {
  pos: ['ORDER_CREATE'],
  kds: ['ITEM_MARK_PREPARING_READY'],
  manage: ['OPERATIONS_CONFIGURE', 'MENU_MANAGE', 'STAFF_MANAGE', 'DEVICE_PAIR'],
};

/** The modes a person may open. The server still checks every call (AUTH-010). */
export function modesFor(person: Person): Mode[] {
  return MODES.filter((mode) =>
    MODE_CAPABILITIES[mode].some((capability) => grantOf(person, capability) !== 'DENY'),
  );
}

/** Where a person lands after signing in: managers manage, the kitchen cooks, others sell. */
export function homeFor(person: Person): Mode {
  const allowed = modesFor(person);
  return (['manage', 'pos', 'kds'] as const).find((mode) => allowed.includes(mode)) ?? 'pos';
}

/**
 * A kitchen screen works in station mode (AUTH-005): it shows its station without anybody signed
 * in, unless the restaurant has kitchen staff sign in individually.
 */
export function isStationMode(device: DeviceSummary | undefined): boolean {
  return device?.type === 'KDS';
}

export function modeOfPath(pathname: string): Mode | undefined {
  const first = pathname.split('/')[1];
  return MODES.find((mode) => mode === first);
}
