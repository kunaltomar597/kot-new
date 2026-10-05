import type { DeviceSummary } from '@rp/contracts';
import { type Capability, grantOf, type PermissionHolder } from '@rp/domain';

/** The console's three modes (MGR-001, KDS-001); each is a route prefix. */
export const MODES = ['pos', 'kds', 'manage'] as const;
export type Mode = (typeof MODES)[number];

/**
 * What opens each mode, from the BRD §4.2 matrix (anything but DENY): the dashboard opens for
 * anyone who may use one of its pages, which a custom role can give without the rest (AUTH-012).
 */
const MODE_CAPABILITIES: Readonly<Record<Mode, readonly Capability[]>> = {
  pos: ['ORDER_CREATE'],
  kds: ['ITEM_MARK_PREPARING_READY'],
  manage: ['OPERATIONS_CONFIGURE', 'MENU_MANAGE', 'STAFF_MANAGE', 'DEVICE_PAIR'],
};

/**
 * The modes a person may open, with their custom role (P4-02e). The server still checks every
 * call (AUTH-010).
 */
export function modesFor(person: PermissionHolder): Mode[] {
  return MODES.filter((mode) =>
    MODE_CAPABILITIES[mode].some((capability) => grantOf(person, capability) !== 'DENY'),
  );
}

/**
 * Where a person lands after signing in: managers (who run operations) manage, the kitchen cooks,
 * others sell, even when a custom role also opens a dashboard page for them.
 */
export function homeFor(person: PermissionHolder): Mode {
  const allowed = modesFor(person);
  const order: readonly Mode[] =
    grantOf(person, 'OPERATIONS_CONFIGURE') === 'DENY'
      ? ['pos', 'kds', 'manage']
      : ['manage', 'pos', 'kds'];
  return order.find((mode) => allowed.includes(mode)) ?? 'pos';
}

/** The dashboard's pages (P4-01, P4-02), in the order the navigation shows them. */
export const MANAGE_PAGES = [
  'overview',
  'orders',
  'alerts',
  'menu',
  'staff',
  'devices',
  'security',
] as const;
export type ManagePage = (typeof MANAGE_PAGES)[number];

/**
 * Who may open each dashboard page: the overview and the order feed read the live order feed
 * (OPERATIONS_CONFIGURE), the alert centre is everyone's, each setup page needs its permission
 * outright, and sign-in security is the Owner's own (AUTH-006).
 */
const PAGE_RULES: Readonly<Record<ManagePage, (person: PermissionHolder) => boolean>> = {
  overview: (person) => grantOf(person, 'OPERATIONS_CONFIGURE') !== 'DENY',
  orders: (person) => grantOf(person, 'OPERATIONS_CONFIGURE') !== 'DENY',
  alerts: () => true,
  menu: (person) => grantOf(person, 'MENU_MANAGE') === 'ALLOW',
  staff: (person) => grantOf(person, 'STAFF_MANAGE') === 'ALLOW',
  devices: (person) => grantOf(person, 'DEVICE_PAIR') === 'ALLOW',
  security: (person) => person.role === 'OWNER',
};

/**
 * The dashboard pages a person may open, with their custom role (P4-02e): a cashier whose custom
 * role manages staff gets the Staff page without the order feed. The server checks every call.
 */
export function managePagesFor(person: PermissionHolder): ManagePage[] {
  return MANAGE_PAGES.filter((page) => PAGE_RULES[page](person));
}

/**
 * The page `/manage` opens on: the overview, or else the setup page the person came for (the
 * alert centre is also in the POS).
 */
export function manageLandingOf(pages: readonly ManagePage[]): ManagePage {
  const order: readonly ManagePage[] = ['overview', 'menu', 'staff', 'devices', 'alerts'];
  return order.find((page) => pages.includes(page)) ?? 'alerts';
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
