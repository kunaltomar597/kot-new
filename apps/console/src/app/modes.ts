import type { DeviceSummary } from '@rp/contracts';
import { type Capability, grantFor, type Role } from '@rp/domain';

/** The console's three modes (MGR-001, KDS-001); each is a route prefix. */
export const MODES = ['pos', 'kds', 'manage'] as const;
export type Mode = (typeof MODES)[number];

/** What a role needs to open each mode, from the BRD §4.2 matrix (never DENY). */
const MODE_CAPABILITY: Readonly<Record<Mode, Capability>> = {
  pos: 'ORDER_CREATE',
  kds: 'ITEM_MARK_PREPARING_READY',
  manage: 'OPERATIONS_CONFIGURE',
};

/** The modes a role may open. The server still checks every call (AUTH-010). */
export function modesFor(role: Role): Mode[] {
  return MODES.filter((mode) => grantFor(role, MODE_CAPABILITY[mode]) !== 'DENY');
}

/** Where a person lands after signing in: managers manage, the kitchen cooks, others sell. */
export function homeFor(role: Role): Mode {
  const allowed = modesFor(role);
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
