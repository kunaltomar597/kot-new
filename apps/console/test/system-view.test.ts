import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import {
  approvalText,
  categorySize,
  deviceLines,
  driveText,
  installChoiceOf,
  momentText,
  serviceLines,
  uptimeText,
} from '../src/manage/system/system-view.js';
import { approval, NOW, offered, systemView, updates, withSupport } from './system-fixture.js';

const t = createTranslator();
const now = new Date(NOW);

const detailOf = (view: ReturnType<typeof systemView>, key: string) => {
  const line = serviceLines(view, now, t).find((entry) => entry.key === key);
  return line === undefined ? undefined : { health: line.health, detail: line.detail };
};

describe('[MGR-010] [NFR-I03] the System page in words', () => {
  it('says how long the server has run', () => {
    expect(uptimeText(0, t)).toBe('Running for 0 min');
    expect(uptimeText(12 * 60 + 59, t)).toBe('Running for 12 min');
    expect(uptimeText(5 * 3_600 + 7 * 60, t)).toBe('Running for 5 h 7 min');
    expect(uptimeText(86_400 + 30, t)).toBe('Running for 1 day 0 h');
    expect(uptimeText(3 * 86_400 + 4 * 3_600 + 120, t)).toBe('Running for 3 days 4 h');
  });

  it('[NFR-U05] puts each service in words, its badge only repeating them', () => {
    expect(serviceLines(systemView(), now, t)).toEqual([
      { key: 'database', name: 'Database', health: 'ok', detail: 'Answers in 2 ms' },
      {
        key: 'pagers',
        name: 'Pager link',
        health: 'ok',
        detail: '3 pagers connected, on port 8883, encrypted',
      },
      {
        key: 'printers',
        name: 'Printers',
        health: 'problem',
        detail: '1 of 2 not printing; 4 tickets waiting',
      },
      { key: 'support', name: 'Support link', health: 'ok', detail: 'Last report at 11:45' },
    ]);
  });

  it('says when the database does not answer, the pagers are off or no printer is set up', () => {
    const view = systemView();
    const down = {
      ...view,
      services: {
        ...view.services,
        database: { up: false, latencyMs: 0 },
        pagerBroker: { running: false, port: null, secure: false, connectedPagers: 0 },
        printers: { total: 0, offline: 0, waiting: 0 },
      },
    };
    expect(detailOf(down, 'database')).toEqual({
      health: 'problem',
      detail: 'Not answering. Restart the server PC; if that does not help, call support.',
    });
    expect(detailOf(down, 'pagers')).toEqual({ health: 'off', detail: 'Switched off on this PC' });
    expect(detailOf(down, 'printers')).toEqual({ health: 'off', detail: 'No printers are set up' });
  });

  it('counts pagers and printers in words', () => {
    const view = systemView();
    const plain = {
      ...view,
      services: {
        ...view.services,
        pagerBroker: { running: true, port: 1883, secure: false, connectedPagers: 0 },
        printers: { total: 2, offline: 0, waiting: 0 },
      },
    };
    expect(detailOf(plain, 'pagers')?.detail).toBe('No pagers connected, on port 1883');
    expect(detailOf(plain, 'printers')).toEqual({
      health: 'ok',
      detail: '2 printers, all printing; nothing waiting',
    });
    const one = {
      ...view,
      services: {
        ...view.services,
        pagerBroker: { running: true, port: 8883, secure: true, connectedPagers: 1 },
        printers: { total: 1, offline: 0, waiting: 1 },
      },
    };
    expect(detailOf(one, 'pagers')?.detail).toBe('1 pager connected, on port 8883, encrypted');
    expect(detailOf(one, 'printers')?.detail).toBe('1 printer, printing; 1 ticket waiting');
  });

  it('[UPD-008] says whether the support link is set up, linked and reporting', () => {
    expect(detailOf(withSupport({ configured: false, enrolled: false }), 'support')).toEqual({
      health: 'off',
      detail: 'Not set up on this PC',
    });
    expect(detailOf(withSupport({ enrolled: false }), 'support')).toEqual({
      health: 'off',
      detail: 'Not linked yet. It is linked when the licence is activated.',
    });
    expect(detailOf(withSupport({ lastError: 'UNREACHABLE' }), 'support')).toEqual({
      health: 'problem',
      detail: 'Support could not be reached the last time',
    });
    expect(detailOf(withSupport({ lastError: 'INSTALLATION_REVOKED' }), 'support')).toEqual({
      health: 'problem',
      detail: 'Support refused the last report (INSTALLATION_REVOKED)',
    });
    expect(detailOf(withSupport({ lastReportAt: null }), 'support')).toEqual({
      health: 'ok',
      detail: 'Linked, no report sent yet',
    });
    // Yesterday at 18:00 in the restaurant.
    expect(
      detailOf(withSupport({ lastReportAt: '2026-10-10T12:30:00.000Z' }), 'support')?.detail,
    ).toMatch(/^Last report on 10 Oct\S* at 18:00$/);
  });

  it('says when something happened: the time today, the day and time before', () => {
    const keys = {
      today: 'system.backups.lastToday',
      earlier: 'system.backups.lastEarlier',
    } as const;
    expect(momentText('2026-10-11T00:30:00.000Z', now, t, keys)).toBe('Last backup at 06:00.');
    // 23:30 IST on the 10th is the day before, though it is the 10th in UTC too.
    expect(momentText('2026-10-10T18:00:00.000Z', now, t, keys)).toMatch(
      /^Last backup on 10 Oct\S* at 23:30\.$/,
    );
  });

  it('[UPD-004] says who approved "Install now" and when', () => {
    expect(approvalText(approval(), now, t)).toBe('Installation approved by Meera at 12:05.');
    expect(approvalText(approval({ approvedAt: '2026-10-09T10:00:00.000Z' }), now, t)).toMatch(
      /^Installation approved by Meera on 9 Oct\S* at 15:30\.$/,
    );
  });

  it('lists paired devices by type in the order of the Devices page', () => {
    expect(deviceLines(systemView().devices).map((group) => group.type)).toEqual([
      'POS',
      'KDS',
      'TABLE_TABLET',
    ]);
  });
});

describe('[DATA-006] the data drive', () => {
  it('says how full it is and what uses the space', () => {
    const { storage } = systemView();
    expect(driveText(storage, t)).toBe('The data drive is 86% full, with 14 GB free of 100 GB.');
    expect(storage.categories.map((entry) => categorySize(entry.bytes, t))).toEqual([
      '1.5 GB',
      '300 MB',
      '120 MB',
      '2 MB',
      'Could not be measured',
    ]);
  });

  it('says when the drive could not be read', () => {
    const { storage } = systemView();
    expect(
      driveText(
        { ...storage, totalBytes: null, freeBytes: null, usedPercent: null, level: null },
        t,
      ),
    ).toBe('The data drive could not be read.');
  });
});

describe('[UPD-004] what "Install now" can do', () => {
  it('installs an offered release when no table is open', () => {
    expect(installChoiceOf(updates())).toEqual({ kind: 'INSTALL', needsReason: false });
  });

  it('waits for the tables to close', () => {
    expect(installChoiceOf(updates({ openTables: 2 }))).toEqual({ kind: 'WAIT_FOR_TABLES' });
  });

  it('installs a security update through open tables once the manager says why', () => {
    expect(
      installChoiceOf(updates({ openTables: 2, offered: offered({ securityCritical: true }) })),
    ).toEqual({ kind: 'INSTALL', needsReason: true });
  });

  it('has nothing to do when nothing is offered or it is approved already', () => {
    expect(installChoiceOf(updates({ offered: null }))).toEqual({ kind: 'NONE' });
    expect(installChoiceOf(updates({ approval: approval(), openTables: 3 }))).toEqual({
      kind: 'APPROVED',
    });
  });
});
