import type { InstallApproval, OfferedUpdate, SystemUpdates, SystemView } from '@rp/contracts';
import { STAFF } from './fakes.js';

/** The System page's details for its tests (P4-04b). */

const GB = 1_024 ** 3;
const MB = 1_024 ** 2;

/** 12:00 in the restaurant (IST) on 11 October. */
export const NOW = '2026-10-11T06:30:00.000Z';

export function offered(overrides: Partial<OfferedUpdate> = {}): OfferedUpdate {
  return {
    version: '1.1.0',
    channel: 'STABLE',
    notes: 'Faster bill printing',
    sizeBytes: 50 * MB,
    publishedAt: '2026-10-10T12:00:00.000Z',
    securityCritical: false,
    ...overrides,
  };
}

/** Meera's "Install now" for 1.1.0 at 12:05 IST. */
export function approval(overrides: Partial<InstallApproval> = {}): InstallApproval {
  return {
    version: '1.1.0',
    approvedAt: '2026-10-11T06:35:00.000Z',
    approvedBy: { id: STAFF.MANAGER.staffId, name: STAFF.MANAGER.displayName },
    reason: null,
    ...overrides,
  };
}

export function updates(overrides: Partial<SystemUpdates> = {}): SystemUpdates {
  return {
    current: '1.0.0',
    channel: 'STABLE',
    offered: offered(),
    maintenanceWindow: { start: '03:00', end: '06:00' },
    approval: null,
    openTables: 0,
    ...overrides,
  };
}

/**
 * Running for 3 days 4 h; the database answers; three pagers on the encrypted port; one of two
 * printers not printing with four tickets waiting; the support link reported at 11:45. Ten table
 * tablets (nine connected), the POS and two kitchen screens (one connected). The drive is 86 %
 * full (over the 80 % warning); backups are not measured. Release 1.1.0 is offered and no table
 * is open.
 */
export function systemView(overrides: Partial<SystemView> = {}): SystemView {
  return {
    checkedAt: NOW,
    uptimeSeconds: 3 * 86_400 + 4 * 3_600 + 120,
    versions: {
      product: '1.0.0',
      server: '0.1.0',
      node: '24.11.0',
      postgres: '16.4',
      buildId: null,
    },
    services: {
      database: { up: true, latencyMs: 2 },
      pagerBroker: { running: true, port: 8883, secure: true, connectedPagers: 3 },
      printers: { total: 2, offline: 1, waiting: 4 },
      controlPlane: {
        configured: true,
        enrolled: true,
        lastReportAt: '2026-10-11T06:15:00.000Z',
        lastError: null,
      },
    },
    devices: [
      { type: 'TABLE_TABLET', paired: 10, connected: 9 },
      { type: 'POS', paired: 1, connected: 1 },
      { type: 'KDS', paired: 2, connected: 1 },
    ],
    storage: {
      totalBytes: 100 * GB,
      freeBytes: 14 * GB,
      usedPercent: 86,
      warnPercent: 80,
      criticalPercent: 90,
      level: 'WARNING',
      categories: [
        { category: 'TRANSACTIONS', bytes: 1.5 * GB },
        { category: 'AUDIT', bytes: 300 * MB },
        { category: 'PHOTOS', bytes: 120 * MB },
        { category: 'LOGS', bytes: 2 * MB },
        { category: 'BACKUPS', bytes: null },
      ],
    },
    backups: {
      walMode: 'CONTINUOUS',
      secondLocation: null,
      keepDaily: 7,
      keepWeekly: 4,
      cloudEnabled: true,
      lastBackupAt: null,
    },
    licence: null,
    updates: updates(),
    ...overrides,
  };
}

/** The same details with the support link changed. */
export function withSupport(
  controlPlane: Partial<SystemView['services']['controlPlane']>,
  view: SystemView = systemView(),
): SystemView {
  return {
    ...view,
    services: {
      ...view.services,
      controlPlane: { ...view.services.controlPlane, ...controlPlane },
    },
  };
}
