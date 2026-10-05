import type { ArchivesResponse, BackupsResponse, SystemStatusResponse } from '@rp/contracts';

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
    qrRelay: {
      configured: true,
      credential: true,
      lastContactAt: '2026-10-02T08:00:00.000Z',
      lastError: null,
      menuVersion: 3,
      realtime: true,
    },
    storage: {
      totalBytes: 256 * GB,
      freeBytes: 97 * GB,
      usedPercent: 62,
      level: 'OK',
      warnPercent: 80,
      criticalPercent: 90,
      retention: {
        operationalDays: 90,
        dinerContactMonths: 24,
        lastRunAt: '2026-10-02T04:40:00.000Z',
        lastRunTotal: 12,
      },
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
    clients: {
      api: { current: '1.0', oldest: '1.0' },
      counts: [
        { compatibility: 'CURRENT', devices: 4 },
        { compatibility: 'UNKNOWN', devices: 1 },
      ],
      builds: [],
    },
    update: {
      offered: {
        version: '1.2.0',
        channel: 'STABLE',
        notes: 'Faster bills.',
        publishedAt: '2026-09-30T10:00:00.000Z',
        sizeBytes: 120 * 1_024 ** 2,
        clientApi: { current: '1.0', oldest: '1.0' },
        leavesBehind: 0,
      },
      installApproval: null,
      maintenanceWindow: { start: '03:00', end: '06:00' },
      openTables: 2,
      agent: {
        state: 'WAITING',
        version: '1.2.0',
        waitingFor: 'OPEN_TABLES',
        error: null,
        retryAt: null,
        lastOutcome: null,
      },
    },
    backup: null,
    licence: null,
    dataDeletionAllowedUntil: null,
    ...overrides,
  };
}

/** The Backups panel (P7-05a): two nights backed up, no second location yet. */
export function backupsView(overrides: Partial<BackupsResponse> = {}): BackupsResponse {
  return {
    health: 'OK',
    lastSuccessAt: '2026-10-01T23:05:00.000Z',
    nextNightlyAt: '2026-10-02T23:00:00.000Z',
    running: false,
    locations: [
      {
        location: 'DATA_DRIVE',
        path: 'D:\\RestaurantData\\backups\\full',
        available: true,
        files: [
          {
            name: 'rp-backup-20261001T230000Z-nightly.rpbk',
            takenAt: '2026-10-01T23:00:00.000Z',
            sizeBytes: 52 * 1_024 ** 2,
          },
          {
            name: 'rp-backup-20260930T230000Z-nightly.rpbk',
            takenAt: '2026-09-30T23:00:00.000Z',
            sizeBytes: 51 * 1_024 ** 2,
          },
        ],
      },
      { location: 'SECOND', path: null, available: false, files: [] },
    ],
    runs: [
      {
        id: '0190a1b2-c3d4-7000-8000-00000000bb01',
        kind: 'NIGHTLY',
        status: 'SUCCEEDED',
        startedAt: '2026-10-01T23:00:00.000Z',
        finishedAt: '2026-10-01T23:05:00.000Z',
        fileName: 'rp-backup-20261001T230000Z-nightly.rpbk',
        sizeBytes: 52 * 1_024 ** 2,
        secondCopy: 'NOT_SET',
        cloud: 'UPLOADED',
        error: null,
        requestedBy: null,
      },
    ],
    keyId: '0123456789abcdef',
    continuous: {
      state: 'NOT_SET_UP',
      mode: 'CONTINUOUS',
      lastArchivedAt: null,
      waiting: 0,
      secondLocationBehind: 0,
      lastBaseBackupAt: null,
      restorableFrom: null,
      error: null,
    },
    cloud: {
      state: 'OK',
      lastUploadAt: '2026-10-01T23:20:00.000Z',
      lastUploadedBackupAt: '2026-10-01T23:00:00.000Z',
      lastFailureAt: null,
      lastError: null,
      keyEscrowedAt: '2026-10-01T23:30:00.000Z',
    },
    restorePending: false,
    lastRestore: null,
    ...overrides,
  };
}

/** Old years (P7-06b): FY 2023-24 may be archived (still within the statutory period). */
export function archivesView(overrides: Partial<ArchivesResponse> = {}): ArchivesResponse {
  return {
    years: [
      {
        financialYear: '2023-24',
        startDate: '2023-04-01',
        endDate: '2024-03-31',
        invoices: 41_200,
        withinStatutoryPeriod: true,
        statutoryUntil: '2030-12-31',
        next: true,
      },
      {
        financialYear: '2024-25',
        startDate: '2024-04-01',
        endDate: '2025-03-31',
        invoices: 52_900,
        withinStatutoryPeriod: true,
        statutoryUntil: '2031-12-31',
        next: false,
      },
    ],
    runs: [],
    running: false,
    ...overrides,
  };
}
