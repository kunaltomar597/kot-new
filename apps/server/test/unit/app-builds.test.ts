import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appKindOfDevice, AppBuildsService } from '../../src/updates/app-builds.service.js';
import { testConfig } from '../helpers/test-app.js';

const config = (appsDir?: string) =>
  testConfig({
    databaseUrl: 'postgresql://localhost/none',
    ...(appsDir !== undefined && { appsDir }),
  });

describe('[WTR-001] the APKs on this PC (P7-04e2)', () => {
  it('offers the waiter app to phones and the tablet app to tablets only', () => {
    expect(appKindOfDevice('WAITER_PHONE')).toBe('waiter-app');
    expect(appKindOfDevice('TABLE_TABLET')).toBe('table-tablet');
    for (const type of ['POS', 'KDS', 'PAGER', 'MANAGER_BROWSER'] as const) {
      expect(appKindOfDevice(type), type).toBeUndefined();
    }
  });

  it('has none without an apps folder or its apps.json (development, a release without APKs)', async () => {
    expect(await new AppBuildsService(config()).list()).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), 'rp-apps-'));
    const builds = new AppBuildsService(config(empty));
    expect(await builds.list()).toEqual([]);
    expect(await builds.forKind('waiter-app')).toBeUndefined();
  });
});
