import { describe, expect, it } from 'vitest';
import { InstallNowRequest, STORAGE_CATEGORIES, SystemUpdates, SystemView } from '../src/index.js';

const updates: SystemUpdates = {
  current: '1.0.0',
  channel: 'STABLE',
  offered: {
    version: '1.1.0',
    channel: 'STABLE',
    notes: null,
    sizeBytes: 52_428_800,
    publishedAt: '2026-10-10T12:00:00.000Z',
    securityCritical: false,
  },
  maintenanceWindow: { start: '03:00', end: '06:00' },
  approval: null,
  openTables: 0,
};

const view: SystemView = {
  checkedAt: '2026-10-11T06:30:00.000Z',
  uptimeSeconds: 120,
  versions: { product: '1.0.0', server: '0.1.0', node: '24.11.0', postgres: null, buildId: null },
  services: {
    database: { up: true, latencyMs: 2 },
    pagerBroker: { running: false, port: null, secure: false, connectedPagers: 0 },
    printers: { total: 0, offline: 0, waiting: 0 },
    controlPlane: { configured: false, enrolled: false, lastReportAt: null, lastError: null },
  },
  devices: [{ type: 'POS', paired: 1, connected: 1 }],
  storage: {
    totalBytes: null,
    freeBytes: null,
    usedPercent: null,
    warnPercent: 80,
    criticalPercent: 90,
    level: null,
    categories: STORAGE_CATEGORIES.map((category) => ({ category, bytes: null })),
  },
  backups: {
    walMode: 'CONTINUOUS',
    secondLocation: null,
    keepDaily: 14,
    keepWeekly: 8,
    cloudEnabled: true,
    lastBackupAt: null,
  },
  licence: null,
  updates,
};

describe('[MGR-010] [NFR-I03] the System page', () => {
  it('[DATA-006] accepts a drive that cannot be read and categories that cannot be measured', () => {
    expect(SystemView.parse(view)).toEqual(view);
    expect(
      SystemView.safeParse({ ...view, storage: { ...view.storage, usedPercent: 101 } }).success,
    ).toBe(false);
    expect(
      SystemView.safeParse({
        ...view,
        storage: { ...view.storage, categories: [{ category: 'MUSIC', bytes: 1 }] },
      }).success,
    ).toBe(false);
  });

  it('[UPD-004] carries whether the offered release is security-critical', () => {
    const { securityCritical: _, ...unflagged } = updates.offered ?? {};
    expect(SystemUpdates.safeParse({ ...updates, offered: unflagged }).success).toBe(false);
  });
});

describe('[UPD-004] "Install now"', () => {
  it('names the release and takes an optional reason of 3 to 200 characters, trimmed', () => {
    expect(InstallNowRequest.parse({ version: '1.1.0' })).toEqual({ version: '1.1.0' });
    expect(InstallNowRequest.parse({ version: '1.1.0', reason: '  Card payments fail ' })).toEqual({
      version: '1.1.0',
      reason: 'Card payments fail',
    });
    for (const reason of ['  ok  ', 'x'.repeat(201)]) {
      expect(InstallNowRequest.safeParse({ version: '1.1.0', reason }).success, reason).toBe(false);
    }
  });

  it('refuses a version that is not one and anything else in the body', () => {
    expect(InstallNowRequest.safeParse({ version: 'latest' }).success).toBe(false);
    expect(InstallNowRequest.safeParse({ version: '1.1.0', force: true }).success).toBe(false);
  });
});
