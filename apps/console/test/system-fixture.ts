import type { SystemStatusResponse } from '@rp/contracts';

const GB = 1_024 ** 3;

/** The System page's status as the server answers it (P4-04): a drive 62% full, one update. */
export function systemStatus(overrides: Partial<SystemStatusResponse> = {}): SystemStatusResponse {
  return {
    checkedAt: '2026-10-01T09:30:00.000Z',
    versions: [
      { name: 'Server', version: '0.1.0' },
      { name: 'Node.js', version: '24.1.0' },
      { name: 'PostgreSQL', version: '16.4' },
    ],
    uptimeSeconds: 2 * 86_400 + 3 * 3_600 + 120,
    database: { status: 'up', latencyMs: 2 },
    controlPlane: { configured: false, enrolled: false, lastContactAt: null, lastError: null },
    storage: {
      totalBytes: 256 * GB,
      freeBytes: 97 * GB,
      usedPercent: 62,
      level: 'OK',
      warnPercent: 80,
      criticalPercent: 90,
      categories: [
        { category: 'TRANSACTIONS', bytes: 3 * 1_024 ** 2 },
        { category: 'AUDIT', bytes: 512 * 1_024 },
        { category: 'PHOTOS', bytes: 42 * 1_024 ** 2 },
        { category: 'LOGS', bytes: 0 },
        { category: 'BACKUPS', bytes: null },
      ],
    },
    devices: [
      { type: 'POS', paired: 1, connected: 1 },
      { type: 'WAITER_PHONE', paired: 4, connected: 3 },
    ],
    update: {
      offered: {
        version: '1.2.0',
        channel: 'STABLE',
        notes: 'Faster bills.',
        publishedAt: '2026-09-30T10:00:00.000Z',
        sizeBytes: 120 * 1_024 ** 2,
      },
      installApproval: null,
      maintenanceWindow: { start: '03:00', end: '06:00' },
      openTables: 2,
    },
    backup: null,
    licence: null,
    ...overrides,
  };
}
