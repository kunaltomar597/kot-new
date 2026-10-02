import type { FleetInstallationView } from '@rp/contracts/control-plane';

export const FLEET_FILTERS = ['ALL', 'ALERTS', 'OFFLINE'] as const;
export type FleetFilter = (typeof FLEET_FILTERS)[number];

/** PCs the dashboard lists: all, those with open alerts, or active ones not heard from. */
export function filterFleet(
  installations: readonly FleetInstallationView[],
  filter: FleetFilter,
): FleetInstallationView[] {
  return installations.filter((pc) => {
    if (filter === 'ALERTS') return pc.openAlerts.length > 0;
    if (filter === 'OFFLINE') return pc.status === 'ACTIVE' && !pc.online;
    return true;
  });
}

/** Connected and paired devices across every type; null when the PC does not say. */
export function deviceTotals(pc: FleetInstallationView): {
  connected: number | null;
  paired: number;
} {
  const paired = pc.devices.reduce((sum, device) => sum + device.paired, 0);
  const unknown = pc.devices.some((device) => device.connected === null);
  const connected = unknown
    ? null
    : pc.devices.reduce((sum, device) => sum + (device.connected ?? 0), 0);
  return { connected, paired };
}

/** The installed product version, from the components the PC reported. */
export function productVersion(pc: FleetInstallationView): string | null {
  return pc.components.find((component) => component.name === 'RESTAURANT_PC')?.version ?? null;
}

/** Counts for the summary line. */
export function fleetSummary(installations: readonly FleetInstallationView[]): {
  active: number;
  online: number;
  alerts: number;
} {
  const active = installations.filter((pc) => pc.status === 'ACTIVE');
  return {
    active: active.length,
    online: active.filter((pc) => pc.online).length,
    alerts: installations.reduce((sum, pc) => sum + pc.openAlerts.length, 0),
  };
}

/** Disk use for people: whole per cent used and gigabytes free; null when not reported. */
export function diskShown(pc: FleetInstallationView): { percent: number; freeGb: string } | null {
  const percent = pc.disk?.usedPercent ?? null;
  if (pc.disk === null || percent === null) return null;
  return { percent, freeGb: (pc.disk.freeBytes / 1_073_741_824).toFixed(1) };
}
