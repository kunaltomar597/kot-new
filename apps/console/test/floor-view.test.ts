import type { FloorResponse, TableOverviewEntry } from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import {
  affectsFloor,
  floorSections,
  minutesSince,
  seatedFor,
  tileAlert,
  tileDetails,
} from '../src/pos/floor-view.js';

const t = createTranslator();
const NOW = Date.parse('2026-09-26T10:00:00.000Z');
const id = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function table(n: number, sectionId: string, archived = false) {
  return {
    id: id(n),
    label: `T${String(n)}`,
    capacity: 4,
    sectionId,
    state: 'FREE' as const,
    displayOrder: n,
    tabletDeviceIds: [],
    archivedAt: archived ? '2026-09-01T00:00:00.000Z' : null,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function live(n: number, overrides: Partial<TableOverviewEntry> = {}): TableOverviewEntry {
  return {
    tableId: id(n),
    label: `T${String(n)}`,
    sectionId: id(100),
    capacity: 4,
    state: 'FREE',
    session: null,
    activeServiceRequests: 0,
    ...overrides,
  };
}

describe('[TBL-007] floor view', () => {
  it('groups live tables by section in display order, skipping archived ones', () => {
    const floor: FloorResponse = {
      sections: [
        {
          id: id(100),
          name: 'Hall',
          displayOrder: 0,
          archivedAt: null,
          updatedAt: '2026-09-01T00:00:00.000Z',
          tables: [table(2, id(100)), table(1, id(100)), table(9, id(100), true)],
        },
        {
          id: id(101),
          name: 'Old wing',
          displayOrder: 1,
          archivedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          tables: [table(5, id(101))],
        },
        {
          id: id(102),
          name: 'Empty',
          displayOrder: 2,
          archivedAt: null,
          updatedAt: '2026-09-01T00:00:00.000Z',
          tables: [],
        },
      ],
    };
    const sections = floorSections(floor, { tables: [live(1), live(2), live(7)] });
    expect(sections.map((section) => [section.name, section.tables.map((x) => x.label)])).toEqual([
      ['Hall', ['T2', 'T1']],
      ['', ['T7']],
    ]);
  });

  it('says how long guests have been seated', () => {
    const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
    expect(minutesSince(at(-5), NOW)).toBe(0);
    expect(seatedFor(at(0), NOW, t)).toBe('0 min');
    expect(seatedFor(at(59), NOW, t)).toBe('59 min');
    expect(seatedFor(at(65), NOW, t)).toBe('1 h 05 min');
  });

  it('lists guests, time and waiter, and what waits for staff', () => {
    const session = {
      id: id(200),
      openedAt: new Date(NOW - 10 * 60_000).toISOString(),
      covers: 1,
      waiterId: id(300),
      waiterName: 'Ravi',
      amountSoFar: 0,
      pendingApprovals: 0,
    };
    expect(tileDetails(live(1), NOW, t)).toEqual([]);
    expect(tileDetails(live(1, { session }), NOW, t)).toEqual(['1 guest', '10 min', 'Ravi']);
    expect(tileAlert(live(1), t)).toBeUndefined();
    expect(tileAlert(live(1, { activeServiceRequests: 2 }), t)).toBe('2 requests');
    expect(
      tileAlert(
        live(1, { session: { ...session, pendingApprovals: 1 }, activeServiceRequests: 2 }),
        t,
      ),
    ).toBe('1 to approve');
  });

  it('refreshes on table, order, bill and service events only', () => {
    for (const type of [
      'TableOpened',
      'TableStateChanged',
      'OrderSubmitted',
      'ItemStatusChanged',
      'BillPrinted',
      'ServiceRequestRaised',
      'MenuPublished',
    ]) {
      expect(affectsFloor(type), type).toBe(true);
    }
    for (const type of ['PrinterStatusChanged', 'SettingsChanged', 'DeviceRevoked']) {
      expect(affectsFloor(type), type).toBe(false);
    }
  });
});
