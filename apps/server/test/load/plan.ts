/**
 * What the load run simulates (P8-01a): the restaurant of BRD §7.2 and its busiest hour, as an
 * open-loop schedule. Orders arrive at the peak rate whether or not the server keeps up, as
 * guests do; the people who react (the kitchen, waiters, cashiers) do so at their own pace.
 * Everything random comes from the seed, so a run can be repeated.
 */

/** Seconds, from and to. */
export type Range = readonly [number, number];

/** How long people take to react, in seconds. Kitchen times are short so that tables turn over. */
export interface Pace {
  /** A ticket on the screen until the cook starts it. */
  readonly startCooking: Range;
  /** Started until ready. */
  readonly cook: Range;
  /** All ready until the ticket is bumped. */
  readonly bump: Range;
  /** An alert until the button on the pager or the phone is pressed. */
  readonly acknowledge: Range;
  /** Food ready until the waiter picks it up (and serves it). */
  readonly pickUp: Range;
  /** A diner's call acknowledged until it is resolved. */
  readonly resolve: Range;
  /** A diner's order on the tablet until the waiter approves it. */
  readonly approve: Range;
  /** A bill asked for until the cashier prints it. */
  readonly cashier: Range;
}

export interface LoadShape {
  // ------------------------------------------------------------ the restaurant
  readonly tables: number;
  readonly sections: number;
  readonly dishes: number;
  readonly categories: number;
  /** Kitchen stations; each has a kitchen screen and a ticket printer. */
  readonly stations: number;
  /** Bill printers at the counter (with the stations' printers: the printers of §7.2). */
  readonly billPrinters: number;
  // ------------------------------------------------------------ people and devices
  /** Table tablets, on the first tables. */
  readonly tablets: number;
  /** Waiters with a phone and a pager; they look after the tables. */
  readonly waiters: number;
  /** Runners with a pager only. */
  readonly runners: number;
  /** Managers with a pager; they also run the dashboards. */
  readonly managers: number;
  /** POS terminals, each with its cashier. */
  readonly posTerminals: number;
  /** Managers' dashboards with the live floor, the order feed and the alerts. */
  readonly dashboards: number;
  /**
   * Live connections in all. Console screens that show only the alert centre (a manager's
   * browser on another page, a spare POS) make up those the devices above do not.
   */
  readonly connections: number;
  // ------------------------------------------------------------ the rush
  readonly ordersPerHour: number;
  readonly minutes: number;
  /** Tables seated before the measured part starts. */
  readonly occupancy: number;
  /** Tables seated each second while warming up. */
  readonly warmUpPerSecond: number;
  /** Diners looking at the suggestions on their tablet. */
  readonly browsesPerHour: number;
  /** Calls for water or a waiter from the tablets. */
  readonly serviceRequestsPerHour: number;
  /** A dish goes out of stock this often, and comes back after half the time. */
  readonly availabilityEverySeconds: number;
  /** A manager runs a twelve-month report this often. */
  readonly reportEverySeconds: number;
  /** Orders sent again with the same idempotency key, as the outbox does after a timeout. */
  readonly retryShare: number;
  readonly pace: Pace;
  // ------------------------------------------------------------ the history
  /** Days of generated orders before today (0: none). */
  readonly historyDays: number;
  readonly historyOrdersPerDay: number;
  readonly seed: number;
}

/** BRD §7.2 at its peak hour, on twelve months of history at 2,000 orders a day. */
export const DESIGN_CAPACITY: LoadShape = {
  tables: 100,
  sections: 4,
  dishes: 1_000,
  categories: 20,
  stations: 6,
  billPrinters: 2,
  tablets: 60,
  waiters: 20,
  runners: 8,
  managers: 2,
  posTerminals: 2,
  dashboards: 2,
  connections: 200,
  ordersPerHour: 300,
  minutes: 20,
  occupancy: 0.8,
  warmUpPerSecond: 1,
  browsesPerHour: 1_800,
  serviceRequestsPerHour: 90,
  availabilityEverySeconds: 60,
  reportEverySeconds: 120,
  retryShare: 0.1,
  pace: {
    startCooking: [5, 20],
    cook: [30, 120],
    bump: [2, 10],
    acknowledge: [2, 10],
    pickUp: [5, 25],
    resolve: [15, 45],
    approve: [5, 20],
    cashier: [5, 20],
  },
  historyDays: 365,
  historyOrdersPerDay: 2_000,
  seed: 20_261_009,
};

/** A small, fast version of the same run for the integration suite. */
export const SMOKE_SHAPE: LoadShape = {
  tables: 12,
  sections: 2,
  dishes: 60,
  categories: 4,
  stations: 2,
  billPrinters: 1,
  tablets: 6,
  waiters: 3,
  runners: 1,
  managers: 1,
  posTerminals: 1,
  dashboards: 1,
  connections: 18,
  ordersPerHour: 2_400,
  minutes: 0.75,
  occupancy: 0.5,
  warmUpPerSecond: 4,
  browsesPerHour: 3_600,
  serviceRequestsPerHour: 720,
  availabilityEverySeconds: 10,
  reportEverySeconds: 15,
  retryShare: 0.2,
  pace: {
    startCooking: [0.2, 1],
    cook: [1, 4],
    bump: [0.2, 1],
    acknowledge: [0.5, 2],
    pickUp: [0.5, 2],
    resolve: [1, 3],
    approve: [0.5, 2],
    cashier: [0.5, 2],
  },
  historyDays: 0,
  historyOrdersPerDay: 0,
  seed: 7,
};

/** What arrives, besides what people do in reaction to it. */
export type ArrivalKind =
  /** Another round at a seated table, from the waiter's phone. */
  | 'NEXT_ROUND'
  /** Diners order on their tablet; the waiter approves. */
  | 'TABLET_ORDER'
  /** A party is seated and orders. */
  | 'NEW_PARTY'
  /** A takeaway order at the counter, billed at once. */
  | 'TAKEAWAY'
  /** A table asks for the bill. */
  | 'BILL'
  | 'SERVICE_REQUEST'
  | 'BROWSE'
  | 'AVAILABILITY'
  | 'REPORT';

/** How the orders of the hour are made up. */
export const ORDER_MIX: Readonly<
  Record<'NEXT_ROUND' | 'TABLET_ORDER' | 'NEW_PARTY' | 'TAKEAWAY', number>
> = { NEXT_ROUND: 0.45, TABLET_ORDER: 0.2, NEW_PARTY: 0.25, TAKEAWAY: 0.1 };

export interface Arrival {
  /** Milliseconds after the measured part starts. */
  readonly atMs: number;
  readonly kind: ArrivalKind;
}

/** mulberry32: a small, fast, seeded generator of numbers in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A number of seconds in the range, as milliseconds. */
export function within(random: () => number, [from, to]: Range): number {
  return Math.round((from + random() * (to - from)) * 1_000);
}

/** Times of a Poisson process at `perHour` over `durationMs`. */
function poisson(random: () => number, perHour: number, durationMs: number): number[] {
  const times: number[] = [];
  if (perHour <= 0) return times;
  const meanGapMs = 3_600_000 / perHour;
  for (let at = -Math.log(1 - random()) * meanGapMs; at < durationMs;) {
    times.push(Math.round(at));
    at += -Math.log(1 - random()) * meanGapMs;
  }
  return times;
}

/** Every `everySeconds`, starting half a period in. */
function periodic(everySeconds: number, durationMs: number): number[] {
  const times: number[] = [];
  const gap = everySeconds * 1_000;
  for (let at = gap / 2; at < durationMs; at += gap) times.push(Math.round(at));
  return times;
}

/**
 * The measured part's schedule, in time order. Bills arrive as often as new parties, so the
 * share of seated tables stays where the warm-up left it.
 */
export function schedule(shape: LoadShape, random: () => number): Arrival[] {
  const durationMs = shape.minutes * 60_000;
  const streams: [ArrivalKind, number[]][] = [
    ...(Object.entries(ORDER_MIX) as [keyof typeof ORDER_MIX, number][]).map(
      ([kind, share]): [ArrivalKind, number[]] => [
        kind,
        poisson(random, shape.ordersPerHour * share, durationMs),
      ],
    ),
    ['BILL', poisson(random, shape.ordersPerHour * ORDER_MIX.NEW_PARTY, durationMs)],
    ['SERVICE_REQUEST', poisson(random, shape.serviceRequestsPerHour, durationMs)],
    ['BROWSE', poisson(random, shape.browsesPerHour, durationMs)],
    ['AVAILABILITY', periodic(shape.availabilityEverySeconds, durationMs)],
    ['REPORT', periodic(shape.reportEverySeconds, durationMs)],
  ];
  return streams
    .flatMap(([kind, times]) => times.map((atMs) => ({ atMs, kind })))
    .sort((a, b) => a.atMs - b.atMs || a.kind.localeCompare(b.kind));
}

/** The console screens that make the live connections up to `shape.connections`. */
export function spareScreenCount(shape: LoadShape): number {
  return Math.max(
    0,
    shape.connections -
      shape.tablets -
      shape.waiters -
      shape.stations -
      shape.posTerminals -
      shape.dashboards,
  );
}

/** Pagers in all: one per waiter, runner and manager. */
export function pagerCount(shape: LoadShape): number {
  return shape.waiters + shape.runners + shape.managers;
}
