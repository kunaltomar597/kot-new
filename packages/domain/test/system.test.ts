import { describe, expect, it } from 'vitest';
import { installNowRefusal, storageLevelOf, usedPercentOf } from '../src/index.js';

const GB = 1024 ** 3;
const levels = { warnPercent: 80, criticalPercent: 90 };

describe('[DATA-006] the data drive', () => {
  it('[DATA-006] gives its use in whole percent, as the disk alert does', () => {
    expect(usedPercentOf(100 * GB, 13.4 * GB)).toBe(87);
    expect(usedPercentOf(100 * GB, 100 * GB)).toBe(0);
    expect(usedPercentOf(100 * GB, 0)).toBe(100);
    // A drive that cannot be read, or free space reported above the size, never goes out of range.
    expect(usedPercentOf(0, 0)).toBe(0);
    expect(usedPercentOf(100 * GB, 120 * GB)).toBe(0);
  });

  it('[DATA-006] is at the warning level from 80 % and critical from 90 %, as set', () => {
    expect(storageLevelOf(79, levels)).toBe('OK');
    expect(storageLevelOf(80, levels)).toBe('WARNING');
    expect(storageLevelOf(89, levels)).toBe('WARNING');
    expect(storageLevelOf(90, levels)).toBe('CRITICAL');
    expect(storageLevelOf(85, { warnPercent: 70, criticalPercent: 85 })).toBe('CRITICAL');
  });
});

describe('[UPD-004] "Install now"', () => {
  const offered = { version: '1.4.0', securityCritical: false };
  const security = { version: '1.4.1', securityCritical: true };

  it('[UPD-004] is approved for the offered release while no table is open', () => {
    expect(installNowRefusal({ offered, version: '1.4.0', openTables: 0 })).toBeNull();
  });

  it('[UPD-004] never applies to a release that is not offered now', () => {
    expect(installNowRefusal({ offered: null, version: '1.4.0', openTables: 0 })).toBe(
      'UPDATE_NOT_OFFERED',
    );
    expect(installNowRefusal({ offered, version: '1.3.9', openTables: 0 })).toBe(
      'UPDATE_NOT_OFFERED',
    );
  });

  it('[UPD-004] waits while tables are open', () => {
    expect(installNowRefusal({ offered, version: '1.4.0', openTables: 2, reason: 'Urgent' })).toBe(
      'TABLES_OPEN',
    );
  });

  it('[UPD-004] lets a security update through open tables with a manager’s reason', () => {
    expect(installNowRefusal({ offered: security, version: '1.4.1', openTables: 3 })).toBe(
      'REASON_REQUIRED',
    );
    expect(
      installNowRefusal({ offered: security, version: '1.4.1', openTables: 3, reason: '  ok ' }),
    ).toBe('REASON_REQUIRED');
    expect(
      installNowRefusal({
        offered: security,
        version: '1.4.1',
        openTables: 3,
        reason: 'Vendor security advice',
      }),
    ).toBeNull();
    expect(installNowRefusal({ offered: security, version: '1.4.1', openTables: 0 })).toBeNull();
  });
});
