import type {
  FloorResponse,
  PagerCredentialResponse,
  PagerView,
  StaffView,
  WaiterAssignmentsResponse,
  WaiterAssignmentView,
} from '@rp/contracts';
import { RESTAURANT_ID, STAFF } from './fakes.js';
import { PRIYA, staffView, team } from './staff-fixture.js';

/** A floor, a crew and pagers for the Today's sections and Pagers pages (P4-02b). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-09-20T10:00:00.000Z';
export const TODAY = '2026-09-28';
export const YESTERDAY = '2026-09-27';

export const HALL = uuid(801);
export const TERRACE = uuid(802);
/** Archived: the rooftop closed for the monsoon. */
export const ROOFTOP = uuid(803);
export const H1 = uuid(811);
export const H2 = uuid(812);
/** Archived table in the hall. */
export const H9 = uuid(819);
export const T7 = uuid(827);
export const T8 = uuid(828);
export const R1 = uuid(831);

export const RAVI = STAFF.WAITER.staffId;
export const MEERA = STAFF.MANAGER.staffId;
export const SUNIL = staffView('WAITER', { id: uuid(841), displayName: 'Sunil' });

function table(id: string, label: string, sectionId: string, archived = false) {
  return {
    id,
    label,
    capacity: 4,
    sectionId,
    state: 'FREE' as const,
    displayOrder: 0,
    tabletDeviceIds: [],
    archivedAt: archived ? AT : null,
    updatedAt: AT,
  };
}

export function sectionsFloor(): FloorResponse {
  return {
    sections: [
      {
        id: HALL,
        name: 'Hall',
        displayOrder: 0,
        archivedAt: null,
        updatedAt: AT,
        tables: [table(H1, 'H1', HALL), table(H2, 'H2', HALL), table(H9, 'H9', HALL, true)],
      },
      {
        id: TERRACE,
        name: 'Terrace',
        displayOrder: 1,
        archivedAt: null,
        updatedAt: AT,
        tables: [table(T7, 'T7', TERRACE), table(T8, 'T8', TERRACE)],
      },
      {
        id: ROOFTOP,
        name: 'Rooftop',
        displayOrder: 2,
        archivedAt: AT,
        updatedAt: AT,
        tables: [table(R1, 'R1', ROOFTOP, true)],
      },
    ],
  };
}

/** Everyone from the Staff page's tests, and Sunil, a second waiter. */
export function crew(): StaffView[] {
  return [...team(), SUNIL];
}

export function crewList(staff: StaffView[] = crew()) {
  return { staff, pinLength: 4 as const };
}

const NAMES: Readonly<Record<string, string>> = {
  [RAVI]: 'Ravi',
  [MEERA]: 'Meera',
  [SUNIL.id]: 'Sunil',
  [PRIYA.id]: 'Priya',
};

export function assignment(
  staffId: string,
  sectionIds: string[],
  tableIds: string[] = [],
): WaiterAssignmentView {
  return { staffId, staffName: NAMES[staffId] ?? 'Someone', sectionIds, tableIds };
}

export function assignments(
  current: WaiterAssignmentView[],
  previous: WaiterAssignmentView[] | null = null,
): WaiterAssignmentsResponse {
  return {
    current: { businessDate: TODAY, assignments: current },
    previous: previous === null ? null : { businessDate: YESTERDAY, assignments: previous },
  };
}

export const PAGER_1 = uuid(851);
export const PAGER_2 = uuid(852);

export function pager(overrides: Partial<PagerView> = {}): PagerView {
  return {
    deviceId: PAGER_1,
    name: 'Pager 1',
    serial: 'WP-0001',
    staffId: RAVI,
    online: true,
    batteryPercent: 80,
    rssi: -60,
    firmwareVersion: '1.0.3',
    lastSeenAt: AT,
    ...overrides,
  };
}

export function pagerList(pagers: PagerView[] = [pager()]) {
  return { pagers, lowBatteryPercent: 15 };
}

export function credential(deviceId: string = PAGER_2): PagerCredentialResponse {
  const topic = (name: string) => `rp/${RESTAURANT_ID}/pagers/${deviceId}/${name}`;
  return {
    deviceId,
    mqttUsername: deviceId,
    mqttPassword: 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6',
    alertsTopic: topic('alerts'),
    ackTopic: topic('ack'),
    heartbeatTopic: topic('heartbeat'),
    mqttPort: 8883,
  };
}

/** `RestaurantChanged` for a part, as the live connection delivers it. */
export function changed(sequence: number, part: 'WAITER_ASSIGNMENTS' | 'DEVICES') {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000008${String(sequence).padStart(2, '0')}`,
      type: 'RestaurantChanged',
      version: 1,
      occurredAt: '2026-09-28T10:00:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: TODAY,
      payload: { part },
    },
  };
}
