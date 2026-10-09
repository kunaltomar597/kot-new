import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type {
  DomainEvent,
  KdsTicketsResponse,
  MenuItem,
  MenuSnapshot,
  OrderLineRequest,
  PendingApprovalsResponse,
  SubmitOrderResponse,
} from '@rp/contracts';
import { addDays } from '@rp/domain';
import { affectsApprovals, affectsFloor } from '@rp/ordering';
import pg from 'pg';
import { type DeviceMetrics, SimulatedDevice } from './device.js';
import { SimulatedPager } from './pager.js';
import { type Arrival, type LoadShape, schedule, seeded, within } from './plan.js';
import type { SimulatedPrinter } from './printer.js';
import type { LoadRestaurant, LoadTable } from './restaurant.js';
import type { LoadTarget } from './server.js';
import { type LatencySummary, SampleSets, Samples } from './stats.js';

const run = promisify(execFile);

/** BRD §7.1's targets the run measures, and the figure each is judged by. */
export const TARGETS = [
  {
    id: 'NFR-P01',
    what: 'Order sent (or a diner’s order approved) → on its kitchen screen',
    budgetMs: 1_000,
    statistic: 'p95',
  },
  {
    id: 'NFR-P02',
    what: 'Order sent → KOT out of the station printer',
    budgetMs: 3_000,
    statistic: 'p95',
  },
  {
    id: 'NFR-P03',
    what: 'Kitchen “Ready”, or a diner’s call → the waiter’s pager',
    budgetMs: 2_000,
    statistic: 'p95',
  },
  {
    id: 'NFR-P04',
    what: 'Availability change → every connected device (the last of each change)',
    budgetMs: 2_000,
    statistic: 'p95',
  },
  {
    id: 'NFR-P08',
    what: 'Bill opened → printed at the counter',
    budgetMs: 3_000,
    statistic: 'p95',
  },
  { id: 'NFR-P09', what: 'Recommendations on a phone or tablet', budgetMs: 200, statistic: 'p95' },
  {
    id: 'NFR-P10',
    what: 'A report over the last twelve months',
    budgetMs: 5_000,
    statistic: 'p95',
  },
  {
    id: 'NFR-P11',
    what: 'Server killed → every client reconnected and in sync (each one)',
    budgetMs: 30_000,
    statistic: 'max',
  },
] as const;

export type TargetId = (typeof TARGETS)[number]['id'];

export interface TargetResult {
  readonly id: TargetId;
  readonly what: string;
  readonly budgetMs: number;
  readonly statistic: 'p95' | 'max';
  readonly summary: LatencySummary;
  readonly met: boolean;
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ServerUsage {
  readonly samples: number;
  readonly cpuMeanPercent: number;
  readonly cpuMaxPercent: number;
  readonly rssMaxMb: number;
  /** Memory in the first and the last minute of the rush, to see it level off or grow. */
  readonly rssFirstMinuteMb: number;
  readonly rssLastMinuteMb: number;
}

export interface RushResult {
  readonly shape: LoadShape;
  readonly businessDate: string;
  readonly startedAt: string;
  readonly measuredMinutes: number;
  readonly devices: number;
  readonly pagers: number;
  readonly targets: readonly TargetResult[];
  /** Every REST call during the measured part, by operation. */
  readonly http: Record<string, LatencySummary>;
  /** Failed calls before the restart, by operation, status and code. */
  readonly errors: Record<string, number>;
  readonly counts: Record<string, number>;
  readonly checks: readonly CheckResult[];
  readonly server: ServerUsage | null;
  /** Parts of a target's time, to see where it goes. */
  readonly breakdown: Record<string, LatencySummary>;
  /** How late this process's own timers ran: above a few tens of ms, the figures are its own. */
  readonly harness: { readonly eventLoopP99Ms: number; readonly eventLoopMaxMs: number };
  readonly restart: {
    readonly downMs: number;
    readonly pagers: LatencySummary;
  } | null;
}

export interface RushOptions {
  readonly shape: LoadShape;
  readonly target: LoadTarget;
  readonly restaurant: LoadRestaurant;
  /** The server's database, for the checks at the end. */
  readonly databaseUrl: string;
  readonly printers: {
    readonly stations: readonly SimulatedPrinter[];
    readonly bills: readonly SimulatedPrinter[];
  };
  /** Kill the server at the end and measure the clients coming back (NFR-P11). */
  readonly restart: boolean;
  readonly log?: (line: string) => void;
}

/** Events after which each screen reads again: the apps' own lists (`useLive`). */
const affectsKds = (type: string) =>
  /^(KotCreated|KotBumped|ItemStatusChanged|TableMoved|OrdersMoved|OrderApproved|SettingsChanged)$/.test(
    type,
  );
const affectsOrderFeed = (type: string) =>
  /^(Order(Submitted|Approved|Rejected)|KotCreated|ItemStatusChanged|TableMoved|OrdersMoved|TableClosed|TableWaiterChanged|MenuPublished|SettingsChanged)$/.test(
    type,
  );
const affectsAlerts = (type: string) => type.startsWith('Alert');
const affectsRequests = (type: string) =>
  /^(ServiceRequest|TableMoved$|OrdersMoved$|TableClosed$)/.test(type);
const affectsTabletOrders = (type: string) =>
  /^(Order(Submitted|Approved|Rejected)|ItemStatusChanged|KotCreated|KotBumped)$/.test(type);

type ServiceType = 'WATER' | 'WAITER';
type SalesChannel = MenuItem['channels'][number];

interface TableState {
  readonly table: LoadTable;
  sessionId: string | null;
  busy: boolean;
  billing: boolean;
  rounds: number;
  /** Lines ordered and not yet served (diners' lines count from their order). */
  unserved: number;
  seatedAt: number;
  readonly openRequests: Set<ServiceType>;
}

interface AlertSeen {
  readonly alertId: string;
  readonly type: string;
  readonly tableId: string | null;
  readonly recipients: readonly string[];
  readonly raisedAt: number;
  /** Acknowledged or cleared: a new one may be raised for the same thing from then on. */
  closedAt: number | null;
  readonly measured: boolean;
}

interface Change {
  readonly itemId: string;
  readonly available: boolean;
  readonly startedAt: number;
  readonly receipts: Map<number, number>;
  readonly measured: boolean;
}

interface Bill {
  readonly invoiceNumber: string;
  readonly printerId: string;
  readonly startedAt: number;
  readonly measured: boolean;
}

interface KotSeen {
  readonly kotId: string;
  readonly kotNumber: number;
  readonly orderId: string;
  readonly stationId: string;
  readonly at: number;
}

/** The trigger an alert answers: the earliest in its window, which it uses up. */
function triggerFor(
  triggers: number[] | undefined,
  after: number,
  until: number,
): number | undefined {
  if (triggers === undefined) return undefined;
  const found = triggers.filter((at) => at > after && at <= until);
  if (found.length === 0) return undefined;
  for (const at of found) triggers.splice(triggers.indexOf(at), 1);
  return Math.min(...found);
}

const REPORTS: readonly (readonly [
  string,
  (device: SimulatedDevice, query: { from: string; to: string }) => Promise<unknown>,
])[] = [
  ['getSalesSummary', (device, query) => device.api.getSalesSummary({ query })],
  ['getItemSales', (device, query) => device.api.getItemSales({ query })],
  ['getGstSummary', (device, query) => device.api.getGstSummary({ query })],
  ['getSourceSales', (device, query) => device.api.getSourceSales({ query })],
  ['getStaffPerformance', (device, query) => device.api.getStaffPerformance({ query })],
  ['getKitchenReport', (device, query) => device.api.getKitchenReport({ query })],
  ['getTableReport', (device, query) => device.api.getTableReport({ query })],
  ['getPaymentModes', (device, query) => device.api.getPaymentModes({ query })],
  ['getDiscountReport', (device, query) => device.api.getDiscountReport({ query })],
  ['getRecommendationReport', (device, query) => device.api.getRecommendationReport({ query })],
];

/**
 * The simulated rush (P8-01a). Connects every device and pager, seats the warm-up's tables, then
 * plays the schedule for `shape.minutes` while the kitchen, waiters and cashiers react; then
 * (with `restart`) kills the server and waits for every client to come back, and checks that
 * every order, ticket, print and alert happened exactly once.
 */
export async function runRush(options: RushOptions): Promise<RushResult> {
  const { shape, target, restaurant } = options;
  const log = options.log ?? (() => undefined);
  const random = seeded(shape.seed);
  const chance = (probability: number) => random() < probability;
  const pick = <T>(values: readonly T[]): T | undefined =>
    values[Math.floor(random() * values.length)];
  const metrics: DeviceMetrics = { http: new SampleSets(), errors: new Map() };
  const counts: Record<string, number> = {};
  const count = (name: string, by = 1) => {
    counts[name] = (counts[name] ?? 0) + by;
  };
  let phase: 'CONNECT' | 'WARM_UP' | 'RUSH' | 'DRAIN' | 'QUIET' = 'CONNECT';
  const measuring = () => phase === 'RUSH';
  const startedAt = new Date().toISOString();
  const timers: NodeJS.Timeout[] = [];

  // ------------------------------------------------------------ devices and pagers
  const devices = restaurant.devices.map(
    (identity) => new SimulatedDevice(identity, target.url, target.ca, metrics),
  );
  const ofKind = (kind: SimulatedDevice['kind']) =>
    devices.filter((device) => device.kind === kind);
  const tablets = ofKind('TABLET');
  const phones = ofKind('WAITER_PHONE');
  const kitchens = ofKind('KDS');
  const counters = ofKind('POS');
  const dashboards = ofKind('DASHBOARD');
  const spares = ofKind('SPARE_SCREEN');
  const observer = dashboards[0];
  const counter = counters[0];
  if (observer === undefined || counter === undefined) throw new Error('No dashboard or POS');
  log(
    `Connecting ${String(devices.length)} devices and ${String(restaurant.pagers.length)} pagers`,
  );
  for (let index = 0; index < devices.length; index += 25) {
    await Promise.all(devices.slice(index, index + 25).map((device) => device.start()));
  }
  const pagers = restaurant.pagers.map(
    (pager) => new SimulatedPager(pager.credential, pager.wearerId),
  );
  const pagerOf = new Map(pagers.map((pager) => [pager.wearerId ?? '', pager]));
  await Promise.all(pagers.map((pager) => pager.connect(target.mqttUrl, target.ca)));
  const menu: MenuSnapshot = await counter.call('getMenu', () => counter.api.getMenu());
  const unavailable = new Set<string>();
  const sellable = (channel: SalesChannel): MenuItem[] =>
    menu.items.filter(
      (item) =>
        item.available &&
        !item.archived &&
        item.channels.includes(channel) &&
        !unavailable.has(item.id),
    );
  const stationOf = new Map(menu.items.map((item) => [item.id, item.stationId]));
  const groups = new Map(menu.modifierGroups.map((group) => [group.id, group]));

  const tables = new Map<string, TableState>(
    restaurant.tables.map((table) => [
      table.id,
      {
        table,
        sessionId: null,
        busy: false,
        billing: false,
        rounds: 0,
        unserved: 0,
        seatedAt: 0,
        openRequests: new Set(),
      },
    ]),
  );
  const tableByLabel = new Map(restaurant.tables.map((table) => [table.label, table.id]));
  const phoneOf = (table: LoadTable) => phones[table.waiter];
  const tabletOf = (table: LoadTable) =>
    table.tablet === null ? undefined : tablets[table.tablet];

  // ------------------------------------------------------------ what the run records
  const kitchenAt = new Map<string, number>();
  const measuredOrders = new Set<string>();
  const orderByNumber = new Map<number, string>();
  const expectedStations = new Map<string, Set<string>>();
  const awaitingApproval = new Set<string>();
  const kdsSeen = new Map<string, KotSeen>();
  /** When a kitchen screen heard of each ticket, before reading it. */
  const kotHeard = new Map<string, { readonly orderId: string; readonly at: number }>();
  const readyTriggers = new Map<string, number[]>();
  const callTriggers = new Map<string, number[]>();
  const alerts = new Map<string, AlertSeen>();
  const changes: Change[] = [];
  const bills: Bill[] = [];
  const samples = {
    recommendations: new Samples(),
    reports: new Samples(),
    billPrinted: new Samples(),
  };
  let retriesNotReplayed = 0;

  // The dashboard hears every alert, with its table and recipients.
  observer.onEvent((event, at) => {
    if (event.type === 'AlertRaised' && event.payload.repeat === 0) {
      alerts.set(event.payload.alertId, {
        alertId: event.payload.alertId,
        type: event.payload.eventType,
        tableId: event.payload.tableId,
        recipients: event.payload.recipients,
        raisedAt: at,
        closedAt: null,
        measured: measuring(),
      });
    } else if (event.type === 'AlertAcknowledged' || event.type === 'AlertCleared') {
      const seen = alerts.get(event.payload.alertId);
      if (seen?.closedAt === null) seen.closedAt = at;
    }
  });
  // Every device hears availability changes (NFR-P04).
  for (const [index, device] of devices.entries()) {
    device.onEvent((event, at) => {
      if (event.type !== 'ItemAvailabilityChanged') return;
      for (let back = changes.length - 1; back >= 0; back -= 1) {
        const change = changes[back];
        if (
          change?.itemId === event.payload.itemId &&
          change.available === event.payload.available &&
          !change.receipts.has(index)
        ) {
          change.receipts.set(index, at);
          return;
        }
      }
    });
  }

  // ------------------------------------------------------------ ordering
  const lines = (channel: SalesChannel): OrderLineRequest[] => {
    const items = sellable(channel);
    return Array.from({ length: 2 + Math.floor(random() * 4) }, () => {
      const item = pick(items);
      if (item === undefined) throw new Error('Nothing on the menu');
      const modifiers = item.modifierGroupIds.flatMap((groupId) => {
        const group = groups.get(groupId);
        const option = group === undefined ? undefined : pick(group.options);
        return option !== undefined && (group?.minSelections ?? 0) + (chance(0.3) ? 1 : 0) > 0
          ? [{ groupId, optionIds: [option.id] }]
          : [];
      });
      const variant = pick(item.variants);
      return {
        clientLineId: randomUUID(),
        itemId: item.id,
        quantity: chance(0.2) ? 2 : 1,
        ...(variant !== undefined && { variantId: variant.id }),
        modifiers,
      };
    });
  };

  /**
   * Sends an order as the app does: again with the same key now and then (the outbox after a
   * timeout), and without the lines the server refused (a dish that just ran out, ORD-017).
   */
  const send = async (
    device: SimulatedDevice,
    operation: 'submitOrder' | 'submitTabletOrder',
    body: (key: string, lines: OrderLineRequest[]) => Promise<SubmitOrderResponse>,
    ordered: OrderLineRequest[],
  ): Promise<{ orderId: string; orderNumber: number; lines: OrderLineRequest[] } | undefined> => {
    let remaining = ordered;
    for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt += 1) {
      const key = randomUUID();
      const sentAt = performance.now();
      const answer = await device.call(operation, () => body(key, remaining));
      if (answer.status === 'PARTIALLY_REJECTED') {
        count('lines refused (dish just ran out)', answer.rejectedLines.length);
        const refused = new Set(answer.rejectedLines.map((line) => line.clientLineId));
        remaining = remaining.filter((line) => !refused.has(line.clientLineId));
        continue;
      }
      if (chance(shape.retryShare)) {
        count('orders sent twice');
        const again = await device.call(operation, () => body(key, remaining));
        if (again.status !== 'ACCEPTED' || !again.replayed || again.orderId !== answer.orderId) {
          retriesNotReplayed += 1;
        }
      }
      orderByNumber.set(answer.orderNumber, answer.orderId);
      expectedStations.set(
        answer.orderId,
        new Set(remaining.map((line) => stationOf.get(line.itemId) ?? '')),
      );
      if (operation === 'submitOrder') kitchenAt.set(answer.orderId, sentAt);
      if (measuring()) measuredOrders.add(answer.orderId);
      return { orderId: answer.orderId, orderNumber: answer.orderNumber, lines: remaining };
    }
    return undefined;
  };

  const recommend = async (device: SimulatedDevice, state: TableState) => {
    const started = performance.now();
    const cart = [pick(menu.items)?.id].filter((id): id is string => id !== undefined);
    if (device.kind === 'TABLET') {
      await device.call('getTableRecommendations', () =>
        device.api.getTableRecommendations({ query: { cart, limit: 6 } }),
      );
    } else {
      await device.call('getRecommendations', () =>
        device.api.getRecommendations({
          query: {
            channel: 'WAITER_APP',
            cart,
            limit: 6,
            ...(state.sessionId !== null && { tableSessionId: state.sessionId }),
          },
        }),
      );
    }
    if (measuring()) samples.recommendations.add(performance.now() - started);
  };

  const round = async (state: TableState) => {
    const phone = phoneOf(state.table);
    const sessionId = state.sessionId;
    if (phone === undefined || sessionId === null) return;
    await recommend(phone, state);
    const sent = await send(
      phone,
      'submitOrder',
      (idempotencyKey, ordered) =>
        phone.api.submitOrder({
          body: {
            idempotencyKey,
            source: 'WAITER_APP',
            orderType: 'DINE_IN',
            tableSessionId: sessionId,
            lines: ordered,
          },
        }),
      lines('WAITER_APP'),
    );
    if (sent === undefined) return;
    state.rounds += 1;
    state.unserved += sent.lines.length;
    count('orders from waiters');
  };

  const seat = async (state: TableState) => {
    const phone = phoneOf(state.table);
    const waiter = restaurant.people.waiters[state.table.waiter];
    if (phone === undefined || waiter === undefined) return;
    state.busy = true;
    try {
      const session = await phone.call('openTable', () =>
        phone.api.openTable({
          params: { tableId: state.table.id },
          body: { covers: 2 + Math.floor(random() * 4), waiterId: waiter.staffId },
        }),
      );
      state.sessionId = session.id;
      state.seatedAt = performance.now();
      state.rounds = 0;
      state.unserved = 0;
      count('tables seated');
      await round(state);
    } finally {
      state.busy = false;
    }
  };

  const seated = (filter: (state: TableState) => boolean = () => true) =>
    [...tables.values()].filter(
      (state) => state.sessionId !== null && !state.busy && !state.billing && filter(state),
    );

  const tabletOrder = async (state: TableState) => {
    const tablet = tabletOf(state.table);
    if (tablet === undefined) return;
    await recommend(tablet, state);
    const sent = await send(
      tablet,
      'submitTabletOrder',
      (idempotencyKey, ordered) =>
        tablet.api.submitTabletOrder({ body: { idempotencyKey, lines: ordered } }),
      lines('TABLE_TABLET'),
    );
    if (sent === undefined) return;
    awaitingApproval.add(sent.orderId);
    state.rounds += 1;
    state.unserved += sent.lines.length;
    count('orders from tablets');
  };

  const takeaway = async () => {
    const till = pick(counters);
    if (till === undefined) return;
    const sent = await send(
      till,
      'submitOrder',
      (idempotencyKey, ordered) =>
        till.api.submitOrder({
          body: {
            idempotencyKey,
            source: 'POS',
            orderType: 'TAKEAWAY',
            customerName: 'Guest',
            lines: ordered,
          },
        }),
      lines('POS'),
    );
    if (sent === undefined) return;
    count('takeaway orders');
    await settle(till, { orderId: sent.orderId });
  };

  /** The cashier opens the bill, issues the invoice, prints it and takes the payment. */
  const settle = async (
    till: SimulatedDevice,
    of: { tableSessionId: string } | { orderId: string },
  ) => {
    const startedAt = performance.now();
    const measured = measuring();
    const printerId =
      restaurant.billPrinterIds[counters.indexOf(till) % restaurant.billPrinterIds.length] ?? '';
    const bill = await till.call('openBill', () => till.api.openBill({ body: of }));
    const invoice = await till.call('issueInvoice', () =>
      till.api.issueInvoice({ params: { id: bill.id }, body: {} }),
    );
    bills.push({ invoiceNumber: invoice.invoiceNumber, printerId, startedAt, measured });
    await till.call('printInvoice', () =>
      till.api.printInvoice({ params: { id: invoice.id }, body: { printerId } }),
    );
    const cash = chance(0.3);
    await till.call('recordPayments', () =>
      till.api.recordPayments({
        params: { id: invoice.id },
        body: {
          idempotencyKey: randomUUID(),
          payments: [
            cash
              ? {
                  mode: 'CASH' as const,
                  amount: invoice.grandTotal,
                  tendered: Math.ceil(invoice.grandTotal / 10_000) * 10_000,
                }
              : { mode: pick(['UPI', 'CARD'] as const) ?? 'UPI', amount: invoice.grandTotal },
          ],
        },
      }),
    );
    count('bills paid');
  };

  const billTable = async () => {
    const ready = seated((state) => state.rounds > 0 && state.unserved === 0).sort(
      (a, b) => a.seatedAt - b.seatedAt,
    )[0];
    if (ready === undefined) {
      count('bills not yet due (every table still eating)');
      return;
    }
    const phone = phoneOf(ready.table);
    const till = pick(counters);
    const sessionId = ready.sessionId;
    if (phone === undefined || till === undefined || sessionId === null) return;
    ready.billing = true;
    try {
      await phone.call('requestBill', () => phone.api.requestBill({ params: { sessionId } }));
      await sleep(within(random, shape.pace.cashier));
      await settle(till, { tableSessionId: sessionId });
      ready.sessionId = null;
      ready.openRequests.clear();
    } finally {
      ready.billing = false;
    }
  };

  const serviceRequest = async () => {
    const type: ServiceType = chance(0.6) ? 'WATER' : 'WAITER';
    const state = pick(
      seated((candidate) => candidate.table.tablet !== null && !candidate.openRequests.has(type)),
    );
    const tablet = state === undefined ? undefined : tabletOf(state.table);
    if (state === undefined || tablet === undefined) return;
    state.openRequests.add(type);
    const key = `${state.table.id}:${type}_REQUEST`;
    const triggers = callTriggers.get(key) ?? [];
    callTriggers.set(key, triggers);
    triggers.push(performance.now());
    await tablet.call('raiseServiceRequest', () =>
      tablet.api.raiseServiceRequest({ body: { type } }),
    );
    count('diners’ calls');
  };

  const browse = async () => {
    const state = pick(seated((candidate) => candidate.table.tablet !== null));
    const tablet = state === undefined ? undefined : tabletOf(state.table);
    if (state === undefined || tablet === undefined) return;
    await recommend(tablet, state);
    count('suggestions looked at');
  };

  const changeAvailability = async (itemId: string, available: boolean) => {
    const manager = dashboards[0];
    if (manager === undefined) return;
    if (!available) unavailable.add(itemId);
    changes.push({
      itemId,
      available,
      startedAt: performance.now(),
      receipts: new Map(),
      measured: measuring(),
    });
    await manager.call('setItemAvailability', () =>
      manager.api.setItemAvailability({
        params: { id: itemId },
        body: { available, stockCount: null },
      }),
    );
    if (available) unavailable.delete(itemId);
    count('availability changes');
  };

  let reportIndex = 0;
  const report = async () => {
    const manager = dashboards[1 % dashboards.length];
    const entry = REPORTS[reportIndex++ % REPORTS.length];
    if (manager === undefined || entry === undefined) return;
    const [operation, ask] = entry;
    const started = performance.now();
    await manager.call(operation, () =>
      ask(manager, { from: addDays(restaurant.businessDate, -365), to: restaurant.businessDate }),
    );
    if (measuring()) samples.reports.add(performance.now() - started);
    count('reports run');
  };

  // ------------------------------------------------------------ the people
  let quiet = false;
  const react = (
    device: SimulatedDevice,
    range: readonly [number, number],
    action: () => Promise<unknown>,
  ) => {
    device.later(within(random, range), () => (quiet ? Promise.resolve() : action()));
  };

  /** One at a time per key: a person does not pick up the same dishes twice at once. */
  const queues = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    queues.set(key, next);
    return next;
  };

  /** Picks up and serves the order's dishes that are ready; returns how many. */
  const serve = async (device: SimulatedDevice, orderId: string): Promise<number> => {
    const order = await device.call('getOrder', () => device.api.getOrder({ params: { orderId } }));
    const ready = order.items.filter((item) => item.state === 'READY');
    await Promise.all(
      ready.map(async (item) => {
        for (const event of ['PICK_UP', 'SERVE'] as const) {
          await device.call('setOrderItemStatus', () =>
            device.api.setOrderItemStatus({ params: { orderItemId: item.id }, body: { event } }),
          );
        }
      }),
    );
    return ready.length;
  };

  // The kitchen: each new ticket is started, cooked, marked ready and bumped.
  for (const kds of kitchens) {
    kds.onEvent((event, at) => {
      if (event.type === 'KotCreated' && !kotHeard.has(event.payload.kotId)) {
        kotHeard.set(event.payload.kotId, { orderId: event.payload.orderId, at });
      }
    });
    kds.screen<KdsTicketsResponse>(
      'getKdsTickets',
      affectsKds,
      () => kds.api.getKdsTickets({ query: {} }),
      (answer, at) => {
        for (const ticket of answer.tickets) {
          if (kdsSeen.has(ticket.kotId)) continue;
          kdsSeen.set(ticket.kotId, {
            kotId: ticket.kotId,
            kotNumber: ticket.kotNumber,
            orderId: ticket.orderId,
            stationId: ticket.stationId,
            at,
          });
          const items = ticket.lines.filter((line) => line.state === 'SENT');
          const tableId =
            ticket.tableLabel === null ? undefined : tableByLabel.get(ticket.tableLabel);
          const step = (orderItemId: string, event: 'START_PREPARING' | 'MARK_READY') =>
            kds.call('setOrderItemStatus', () =>
              kds.api.setOrderItemStatus({ params: { orderItemId }, body: { event } }),
            );
          react(kds, shape.pace.startCooking, async () => {
            await Promise.all(items.map((line) => step(line.orderItemId, 'START_PREPARING')));
            react(kds, shape.pace.cook, async () => {
              if (tableId !== undefined) {
                const triggers = readyTriggers.get(tableId) ?? [];
                readyTriggers.set(tableId, triggers);
                triggers.push(performance.now());
              }
              await Promise.all(items.map((line) => step(line.orderItemId, 'MARK_READY')));
              count('tickets cooked');
              if (tableId === undefined) {
                // Takeaway: the cashier hands it over when the token is called.
                react(counter, shape.pace.pickUp, () =>
                  inTurn(ticket.orderId, () => serve(counter, ticket.orderId)),
                );
              }
              react(kds, shape.pace.bump, () =>
                kds.call('bumpKot', () => kds.api.bumpKot({ params: { kotId: ticket.kotId } })),
              );
            });
          });
        }
      },
    );
  }

  // Waiters: their phone's screens, approvals, and what they do when alerted.
  for (const [index, phone] of phones.entries()) {
    const waiter = restaurant.people.waiters[index];
    if (waiter === undefined) continue;
    const pager = pagerOf.get(waiter.staffId);
    const approving = new Set<string>();
    phone.screen('getTableOverview', affectsFloor, () => phone.api.getTableOverview());
    phone.screen('listServiceRequests', affectsRequests, () => phone.api.listServiceRequests());
    phone.screen('listDeviceAlerts', affectsAlerts, () => phone.api.listDeviceAlerts());
    phone.screen<PendingApprovalsResponse>(
      'listPendingApprovals',
      affectsApprovals,
      () => phone.api.listPendingApprovals(),
      (answer) => {
        for (const { order, waiterId } of answer.orders) {
          if (waiterId !== waiter.staffId || approving.has(order.id)) continue;
          approving.add(order.id);
          react(phone, shape.pace.approve, async () => {
            kitchenAt.set(order.id, performance.now());
            await phone.call('approveOrder', () =>
              phone.api.approveOrder({ params: { orderId: order.id }, body: {} }),
            );
            awaitingApproval.delete(order.id);
            count('diners’ orders approved');
          });
        }
      },
    );
    const acknowledge = (alertId: string) => {
      react(phone, shape.pace.acknowledge, async () => {
        // Already dealt with (picked up, or acknowledged on another device).
        const closedAt = alerts.get(alertId)?.closedAt;
        if (closedAt !== undefined && closedAt !== null) return;
        if (pager !== undefined && chance(0.5)) await pager.acknowledge(alertId);
        else {
          await phone.call('acknowledgeDeviceAlert', () =>
            phone.api.acknowledgeDeviceAlert({ params: { alertId } }),
          );
        }
      });
    };
    phone.onEvent((event: DomainEvent) => {
      if (event.type !== 'AlertRaised' || event.payload.repeat !== 0) return;
      if (!event.payload.recipients.includes(waiter.staffId)) return;
      const { alertId, eventType, tableId } = event.payload;
      const state = tableId === null ? undefined : tables.get(tableId);
      if (eventType === 'ITEM_READY' && state !== undefined) {
        acknowledge(alertId);
        react(phone, shape.pace.pickUp, () =>
          inTurn(state.table.id, async () => {
            const sessionId = state.sessionId;
            if (sessionId === null) return;
            const orders = await phone.call('listSessionOrders', () =>
              phone.api.listSessionOrders({ params: { sessionId } }),
            );
            let served = 0;
            for (const order of orders.orders) {
              if (order.items.some((item) => item.state === 'READY')) {
                served += await serve(phone, order.id);
              }
            }
            state.unserved = Math.max(0, state.unserved - served);
          }),
        );
      } else if (
        (eventType === 'WATER_REQUEST' || eventType === 'WAITER_REQUEST') &&
        state !== undefined
      ) {
        acknowledge(alertId);
        react(phone, shape.pace.resolve, async () => {
          const open = await phone.call('listServiceRequests', () =>
            phone.api.listServiceRequests(),
          );
          const type = eventType === 'WATER_REQUEST' ? 'WATER' : 'WAITER';
          const request = open.requests.find(
            (entry) => entry.tableId === state.table.id && entry.type === type,
          );
          if (request !== undefined) {
            await phone.call('resolveServiceRequest', () =>
              phone.api.resolveServiceRequest({ params: { requestId: request.id } }),
            );
          }
          state.openRequests.delete(type);
        });
      } else if (eventType !== 'ORDER_PENDING_APPROVAL') {
        acknowledge(alertId);
      }
    });
  }
  // Runners and managers press the button on whatever their pager shows.
  for (const pager of pagers) {
    if (phones.some((phone) => phone.identity.person?.staffId === pager.wearerId)) continue;
    const answered = new Set<string>();
    const timer = setInterval(() => {
      for (const { message } of pager.receipts) {
        if (message.state !== 'ALERT' || answered.has(message.alertId)) continue;
        answered.add(message.alertId);
        setTimeout(
          () => {
            if (!quiet) void pager.acknowledge(message.alertId).catch(() => undefined);
          },
          within(random, shape.pace.acknowledge),
        );
      }
    }, 500);
    timers.push(timer);
  }
  // The other screens read what they show, as the apps do.
  for (const till of counters) {
    till.screen('getTableOverview', affectsFloor, () => till.api.getTableOverview());
    till.screen('listAlerts', affectsAlerts, () => till.api.listAlerts());
  }
  for (const dashboard of dashboards) {
    dashboard.screen('getOrderFeed', affectsOrderFeed, () => dashboard.api.getOrderFeed());
    dashboard.screen('getTableOverview', affectsFloor, () => dashboard.api.getTableOverview());
    dashboard.screen('listAlerts', affectsAlerts, () => dashboard.api.listAlerts());
  }
  for (const spare of spares)
    spare.screen('listAlerts', affectsAlerts, () => spare.api.listAlerts());
  for (const tablet of tablets) {
    tablet.screen('listTabletOrders', affectsTabletOrders, () => tablet.api.listTabletOrders());
    tablet.screen('listTableServiceRequests', affectsRequests, () =>
      tablet.api.listTableServiceRequests(),
    );
  }
  for (const till of counters) {
    await till.call('openShift', () => till.api.openShift({ body: { openingFloat: 500_000 } }));
  }
  await Promise.all(devices.map((device) => device.connect()));

  // ------------------------------------------------------------ the server's load
  const usage: { cpu: number; rss: number }[] = [];
  const sampler = setInterval(() => {
    const pid = target.pid;
    if (pid === undefined || !measuring()) return;
    run('ps', ['-o', '%cpu=,rss=', '-p', String(pid)]).then(
      ({ stdout }) => {
        const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
        if (cpu !== undefined && rss !== undefined) usage.push({ cpu, rss });
      },
      () => undefined,
    );
  }, 5_000);
  timers.push(sampler);
  const loop = monitorEventLoopDelay({ resolution: 10 });

  // ------------------------------------------------------------ warm-up
  phase = 'WARM_UP';
  const inFlight = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    const settled = work.catch((error: unknown) => {
      count(`actions failed: ${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`);
    });
    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
  };
  const warm = [...tables.values()]
    .sort(() => random() - 0.5)
    .slice(0, Math.round(shape.occupancy * shape.tables));
  log(`Seating ${String(warm.length)} tables`);
  for (const state of warm) {
    track(seat(state));
    await sleep(1_000 / shape.warmUpPerSecond);
  }
  await Promise.all([...inFlight]);

  // ------------------------------------------------------------ the rush
  const plan: Arrival[] = schedule(shape, random);
  log(`Rush: ${String(plan.length)} arrivals over ${String(shape.minutes)} minutes`);
  phase = 'RUSH';
  metrics.http.clear();
  loop.enable();
  const rushStart = performance.now();
  for (const arrival of plan) {
    const wait = rushStart + arrival.atMs - performance.now();
    if (wait > 0) await sleep(wait);
    track(dispatch(arrival));
  }
  await sleep(Math.max(0, rushStart + shape.minutes * 60_000 - performance.now()));
  phase = 'DRAIN';
  loop.disable();
  const measuredMinutes = (performance.now() - rushStart) / 60_000;
  log('Draining');
  await Promise.race([Promise.all([...inFlight]), sleep(120_000)]);
  // What was sent last reaches its screens and printers.
  await sleep(5_000);

  function dispatch(arrival: Arrival): Promise<unknown> {
    switch (arrival.kind) {
      case 'NEXT_ROUND': {
        const state = pick(seated());
        return state === undefined ? takeaway() : round(state);
      }
      case 'TABLET_ORDER': {
        const state = pick(seated((candidate) => candidate.table.tablet !== null));
        return state === undefined ? takeaway() : tabletOrder(state);
      }
      case 'NEW_PARTY': {
        const free = [...tables.values()].filter(
          (state) => state.sessionId === null && !state.busy && !state.billing,
        );
        const state = pick(free);
        if (state === undefined) count('parties turned away (no free table)');
        return state === undefined ? takeaway() : seat(state);
      }
      case 'TAKEAWAY':
        return takeaway();
      case 'BILL':
        return billTable();
      case 'SERVICE_REQUEST':
        return serviceRequest();
      case 'BROWSE':
        return browse();
      case 'AVAILABILITY': {
        const item = pick(sellable('POS'));
        if (item === undefined) return Promise.resolve();
        return changeAvailability(item.id, false).then(() =>
          sleep((shape.availabilityEverySeconds * 1_000) / 2).then(() =>
            changeAvailability(item.id, true),
          ),
        );
      }
      case 'REPORT':
        return report();
    }
  }

  // ------------------------------------------------------------ the restart
  quiet = true;
  phase = 'QUIET';
  const errorsBefore = Object.fromEntries(metrics.errors);
  let restart: RushResult['restart'] = null;
  const reconnection = new Samples();
  if (options.restart) {
    log('Killing the server');
    const synced = devices.map((device) => device.syncedAt.length);
    const reconnected = pagers.map((pager) => pager.reconnectedAt.length);
    const { stoppedAt, healthyAt } = await target.restart();
    const deadline = performance.now() + 60_000;
    while (
      performance.now() < deadline &&
      (devices.some((device, index) => device.syncedAt.length <= (synced[index] ?? 0)) ||
        pagers.some((pager, index) => pager.reconnectedAt.length <= (reconnected[index] ?? 0)))
    ) {
      await sleep(100);
    }
    const pagerTimes = new Samples();
    // One that never came back counts as the whole wait.
    const now = performance.now();
    for (const [index, device] of devices.entries()) {
      reconnection.add((device.syncedAt[synced[index] ?? 0] ?? now) - stoppedAt);
    }
    for (const [index, pager] of pagers.entries()) {
      pagerTimes.add((pager.reconnectedAt[reconnected[index] ?? 0] ?? now) - stoppedAt);
    }
    restart = { downMs: healthyAt - stoppedAt, pagers: pagerTimes.summary() };
    // Everyone hears what happens next.
    const item = sellable('POS')[0];
    if (item !== undefined) {
      await changeAvailability(item.id, false);
      await sleep(3_000);
      await changeAvailability(item.id, true);
      await sleep(3_000);
    }
  }

  // ------------------------------------------------------------ the figures
  const p01 = new Samples();
  for (const seen of kdsSeen.values()) {
    const sentAt = kitchenAt.get(seen.orderId);
    if (sentAt !== undefined && measuredOrders.has(seen.orderId)) p01.add(seen.at - sentAt);
  }
  const heard = new Samples();
  for (const entry of kotHeard.values()) {
    const sentAt = kitchenAt.get(entry.orderId);
    if (sentAt !== undefined && measuredOrders.has(entry.orderId)) heard.add(entry.at - sentAt);
  }
  const p02 = new Samples();
  const stationPrinter = new Map(
    restaurant.stations.map((station, index) => [station.id, options.printers.stations[index]]),
  );
  for (const printer of options.printers.stations) {
    for (const job of printer.jobs) {
      const orderId = job.orderNumber === null ? undefined : orderByNumber.get(job.orderNumber);
      const sentAt = orderId === undefined ? undefined : kitchenAt.get(orderId);
      if (orderId !== undefined && sentAt !== undefined && measuredOrders.has(orderId)) {
        p02.add(job.at - sentAt);
      }
    }
  }
  const p03 = new Samples();
  let unmatchedAlerts = 0;
  const byRaise = [...alerts.values()].sort((a, b) => a.raisedAt - b.raisedAt);
  const lastClosed = new Map<string, number>();
  for (const alert of byRaise) {
    if (alert.tableId === null) continue;
    const kind = alert.type === 'ITEM_READY' ? 'ITEM_READY' : alert.type;
    if (!['ITEM_READY', 'WATER_REQUEST', 'WAITER_REQUEST'].includes(kind)) continue;
    const key = `${alert.tableId}:${kind}`;
    const trigger = triggerFor(
      kind === 'ITEM_READY' ? readyTriggers.get(alert.tableId) : callTriggers.get(key),
      lastClosed.get(key) ?? Number.NEGATIVE_INFINITY,
      alert.raisedAt,
    );
    if (alert.closedAt !== null) lastClosed.set(key, alert.closedAt);
    if (!alert.measured) continue;
    if (trigger === undefined) {
      unmatchedAlerts += 1;
      continue;
    }
    for (const recipient of alert.recipients) {
      const receipt = pagerOf
        .get(recipient)
        ?.receipts.find(
          ({ message }) => message.alertId === alert.alertId && message.state === 'ALERT',
        );
      if (receipt !== undefined) p03.add(receipt.at - trigger);
    }
  }
  const p04 = new Samples();
  for (const change of changes) {
    if (!change.measured || change.receipts.size < devices.length) continue;
    p04.add(Math.max(...change.receipts.values()) - change.startedAt);
  }
  const billPrinters = new Map(
    restaurant.billPrinterIds.map((id, index) => [id, options.printers.bills[index]]),
  );
  for (const bill of bills) {
    const job = billPrinters
      .get(bill.printerId)
      ?.jobs.find((entry) => entry.invoiceNumber === bill.invoiceNumber);
    if (bill.measured && job !== undefined) samples.billPrinted.add(job.at - bill.startedAt);
  }
  const figures: Record<TargetId, Samples> = {
    'NFR-P01': p01,
    'NFR-P02': p02,
    'NFR-P03': p03,
    'NFR-P04': p04,
    'NFR-P08': samples.billPrinted,
    'NFR-P09': samples.recommendations,
    'NFR-P10': samples.reports,
    'NFR-P11': reconnection,
  };
  const targets = TARGETS.filter((entry) => entry.id !== 'NFR-P11' || options.restart).map(
    (entry): TargetResult => {
      const summary = figures[entry.id].summary();
      const value = entry.statistic === 'max' ? summary.max : summary.p95;
      return { ...entry, summary, met: value !== null && value <= entry.budgetMs };
    },
  );

  // ------------------------------------------------------------ the checks
  const checks = await checkRun({
    databaseUrl: options.databaseUrl,
    restaurant,
    expectedStations,
    awaitingApproval,
    kdsSeen,
    stationPrinter,
    billPrinters,
    bills,
    alerts,
    pagerOf,
    changes,
    devices,
    retries: counts['orders sent twice'] ?? 0,
    retriesNotReplayed,
    errors: errorsBefore,
  });
  count('alerts without a trigger found', unmatchedAlerts);
  count(
    'pager messages',
    pagers.reduce((sum, pager) => sum + pager.receipts.length, 0),
  );

  for (const timer of timers) clearInterval(timer);
  for (const device of devices) device.stop();
  await Promise.all(pagers.map((pager) => pager.stop()));

  const cpu = usage.map((entry) => entry.cpu);
  return {
    shape,
    businessDate: restaurant.businessDate,
    startedAt,
    measuredMinutes,
    devices: devices.length,
    pagers: pagers.length,
    targets,
    http: metrics.http.summaries(),
    errors: errorsBefore,
    counts,
    checks,
    server:
      usage.length === 0
        ? null
        : {
            samples: usage.length,
            cpuMeanPercent: average(cpu),
            cpuMaxPercent: Math.max(...cpu),
            rssMaxMb: Math.max(...usage.map((entry) => entry.rss)) / 1_024,
            rssFirstMinuteMb: average(usage.slice(0, 12).map((entry) => entry.rss)) / 1_024,
            rssLastMinuteMb: average(usage.slice(-12).map((entry) => entry.rss)) / 1_024,
          },
    breakdown: { 'NFR-P01: the ticket’s event at the kitchen screen': heard.summary() },
    harness: {
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      eventLoopMaxMs: loop.max / 1e6,
    },
    restart,
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface CheckInput {
  readonly databaseUrl: string;
  readonly restaurant: LoadRestaurant;
  readonly expectedStations: ReadonlyMap<string, ReadonlySet<string>>;
  readonly awaitingApproval: ReadonlySet<string>;
  readonly kdsSeen: ReadonlyMap<string, KotSeen>;
  readonly stationPrinter: ReadonlyMap<string, SimulatedPrinter | undefined>;
  readonly billPrinters: ReadonlyMap<string, SimulatedPrinter | undefined>;
  readonly bills: readonly Bill[];
  readonly alerts: ReadonlyMap<string, AlertSeen>;
  readonly pagerOf: ReadonlyMap<string, SimulatedPager>;
  readonly changes: readonly Change[];
  readonly devices: readonly SimulatedDevice[];
  readonly retries: number;
  readonly retriesNotReplayed: number;
  readonly errors: Record<string, number>;
}

/** S1's "zero lost or duplicate orders/KOTs", and that every print and alert arrived once. */
async function checkRun(input: CheckInput): Promise<CheckResult[]> {
  const client = new pg.Client({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    const { restaurantId, businessDate } = input.restaurant;
    const orders = await client.query<{ id: string }>(
      `SELECT id FROM orders WHERE restaurant_id = $1 AND business_date = $2`,
      [restaurantId, businessDate],
    );
    const kots = await client.query<{
      id: string;
      order_id: string;
      station_id: string;
      kot_number: number;
      order_number: number;
      print_status: string;
    }>(
      `SELECT k.id, k.order_id, k.station_id, k.kot_number, o.order_number, k.print_status
       FROM kots k JOIN orders o ON o.id = k.order_id
       WHERE k.restaurant_id = $1 AND k.business_date = $2 AND k.kind = 'NEW'`,
      [restaurantId, businessDate],
    );
    const checks: CheckResult[] = [];
    const add = (name: string, problems: readonly string[], total: number) => {
      checks.push({
        name,
        ok: problems.length === 0,
        detail:
          problems.length === 0
            ? `${String(total)} checked`
            : `${String(problems.length)} of ${String(total)}: ${problems.slice(0, 5).join('; ')}`,
      });
    };

    const stored = new Set(orders.rows.map((row) => row.id));
    add(
      'Every order stored once, none extra',
      [
        ...[...input.expectedStations.keys()]
          .filter((id) => !stored.has(id))
          .map((id) => `${id} missing`),
        ...[...stored].filter((id) => !input.expectedStations.has(id)).map((id) => `${id} extra`),
      ],
      stored.size,
    );
    add(
      'Every order sent twice was answered with the first',
      input.retriesNotReplayed === 0 ? [] : [`${String(input.retriesNotReplayed)} not replayed`],
      input.retries,
    );

    const byOrder = new Map<string, string[]>();
    for (const kot of kots.rows) {
      byOrder.set(kot.order_id, [...(byOrder.get(kot.order_id) ?? []), kot.station_id]);
    }
    const ticketProblems: string[] = [];
    for (const [orderId, stations] of input.expectedStations) {
      if (input.awaitingApproval.has(orderId)) continue;
      const made = byOrder.get(orderId) ?? [];
      if (made.length !== stations.size || [...stations].some((id) => !made.includes(id))) {
        ticketProblems.push(
          `order ${orderId}: ${String(made.length)} tickets for ${String(stations.size)} stations`,
        );
      }
    }
    add(
      'One KOT per station of each order, none duplicated',
      ticketProblems,
      input.expectedStations.size,
    );

    add(
      'Every KOT on its station’s kitchen screen',
      kots.rows
        .filter((kot) => !input.kdsSeen.has(kot.id))
        .map((kot) => `KOT ${String(kot.kot_number)}`),
      kots.rows.length,
    );

    const printProblems: string[] = [];
    for (const kot of kots.rows) {
      const jobs =
        input.stationPrinter
          .get(kot.station_id)
          ?.jobs.filter(
            (job) => job.kotNumber === kot.kot_number && job.orderNumber === kot.order_number,
          ).length ?? 0;
      if (jobs !== 1 || kot.print_status !== 'PRINTED') {
        printProblems.push(
          `KOT ${String(kot.kot_number)}: ${String(jobs)} printed, ${kot.print_status}`,
        );
      }
    }
    add('Every KOT printed once at its station', printProblems, kots.rows.length);

    add(
      'Every bill printed once at its counter',
      input.bills
        .map((bill) => ({
          bill,
          printed:
            input.billPrinters
              .get(bill.printerId)
              ?.jobs.filter((job) => job.invoiceNumber === bill.invoiceNumber).length ?? 0,
        }))
        .filter(({ printed }) => printed !== 1)
        .map(({ bill, printed }) => `${bill.invoiceNumber}: ${String(printed)}`),
      input.bills.length,
    );

    const missed: string[] = [];
    let delivered = 0;
    for (const alert of input.alerts.values()) {
      for (const recipient of alert.recipients) {
        const pager = input.pagerOf.get(recipient);
        if (pager === undefined) continue;
        delivered += 1;
        if (!pager.receipts.some(({ message }) => message.alertId === alert.alertId)) {
          missed.push(`${alert.type} ${alert.alertId}`);
        }
      }
    }
    add('Every alert reached the pagers of its people', missed, delivered);

    add(
      'Every availability change reached every device',
      input.changes
        .filter((change) => change.receipts.size < input.devices.length)
        .map(
          (change) =>
            `${change.available ? 'back' : 'out'}: ${String(input.devices.length - change.receipts.size)} devices missed it`,
        ),
      input.changes.length,
    );

    add(
      'Every device stayed paired and signed in',
      input.devices
        .filter((device) => device.ended !== undefined)
        .map((device) => `${device.kind}: ${device.ended ?? ''}`),
      input.devices.length,
    );

    add(
      'No request failed',
      Object.entries(input.errors).map(([key, times]) => `${key} ×${String(times)}`),
      Object.values(input.errors).reduce((sum, value) => sum + value, 0),
    );
    return checks;
  } finally {
    await client.end();
  }
}
