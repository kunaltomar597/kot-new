import type { KdsTicket, KdsTicketLine, KdsTicketsResponse } from '@rp/contracts';

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const KDS_IDS = { station: uuid(900), order: uuid(901) } as const;
export const NOW = '2026-09-26T10:00:00.000Z';
export const minutesAgo = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

export function line(n: number, overrides: Partial<KdsTicketLine> = {}): KdsTicketLine {
  return {
    orderItemId: uuid(n),
    quantity: 1,
    name: `Dish ${String(n)}`,
    variantName: null,
    modifiers: [],
    instructions: null,
    comboName: null,
    state: 'SENT',
    readyAt: null,
    ...overrides,
  };
}

export function ticket(n: number, overrides: Partial<KdsTicket> = {}): KdsTicket {
  return {
    kotId: uuid(n),
    kotNumber: n,
    kind: 'NEW',
    stationId: KDS_IDS.station,
    stationName: 'Kitchen',
    orderId: KDS_IDS.order,
    orderNumber: 3,
    tableLabel: 'T4',
    takeawayToken: null,
    movedFrom: null,
    waiterName: 'Ravi',
    source: 'WAITER_APP',
    createdAt: minutesAgo(2),
    bumpedAt: null,
    managerNotified: false,
    lines: [line(n * 10 + 1)],
    ...overrides,
  };
}

export function board(
  tickets: KdsTicket[],
  overrides: Partial<KdsTicketsResponse> = {},
): KdsTicketsResponse {
  return {
    station: { id: KDS_IDS.station, name: 'Kitchen' },
    tickets,
    recentlyBumped: [],
    settings: {
      ageAmberMinutes: 10,
      ageRedMinutes: 20,
      readyNotCollectedMinutes: 3,
      soundVolumePercent: 70,
    },
    serverTime: NOW,
    ...overrides,
  };
}
