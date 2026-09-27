import { DAYPARTS, RECOMMENDATION_LAYERS } from '@rp/domain';
import { z } from 'zod';
import { Id, IsoDate, SalesChannel, Timestamp } from './common.js';
import { TimeWindow } from './settings.js';

/**
 * Recommendations (P3-04, REC-001 to REC-008, REC-011): suggestions for a table's order from the
 * restaurant's rules, then learned pairings (P6-02), then its best sellers for the time of day,
 * each with the reason it is suggested. Table-level only (REC-007): the input is the table's order
 * and cart, never a person.
 */

/** Where a suggestion came from, highest precedence first (REC-001). */
export const RecommendationLayer = z.enum(RECOMMENDATION_LAYERS);
export type RecommendationLayer = z.infer<typeof RecommendationLayer>;

/** The time-of-day windows best sellers are counted in (`reco.dayparts`). */
export const Daypart = z.enum(DAYPARTS);
export type Daypart = z.infer<typeof Daypart>;

/** Why an item is suggested, in data; the apps put it in words (REC-006, `describeRecommendation`). */
export const RecommendationReason = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('RULE'),
    ruleId: Id,
    /** The restaurant's own words ("Cools the spice"), or null for "Goes well with …". */
    label: z.string().nullable(),
    /** The dish or category in the order that triggered the rule. */
    becauseOf: z.string(),
  }),
  z.object({ kind: z.literal('LEARNED'), becauseOf: z.string() }),
  /** A best seller of this time of day, or of the whole day outside every window. */
  z.object({ kind: z.literal('BEST_SELLER'), daypart: Daypart.nullable() }),
]);
export type RecommendationReason = z.infer<typeof RecommendationReason>;

export const RecommendationView = z.object({
  itemId: Id,
  layer: RecommendationLayer,
  reason: RecommendationReason,
});
export type RecommendationView = z.infer<typeof RecommendationView>;

export const RecommendationsResponse = z.object({
  /** Best first; items the published menu lists, servable on the channel now (REC-005). */
  recommendations: z.array(RecommendationView),
  /** The time of day the best sellers are of; null outside every window. */
  daypart: Daypart.nullable(),
  /** The published menu version the suggestions come from. */
  menuVersion: z.int().positive(),
});
export type RecommendationsResponse = z.infer<typeof RecommendationsResponse>;

/** A query parameter that may be repeated (`?cart=a&cart=b`), given once, or left out. */
const RepeatedIds = z
  .union([Id, z.array(Id).max(100)])
  .optional()
  .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]));

/** `true` or `false`, as a query string carries it. */
const QueryFlag = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
  .default(false);

const Limit = z.coerce.number().int().min(1).max(20).default(6);

/**
 * The staff side (waiter app, POS): the suggestions for a table, or for a takeaway cart without
 * one. `cart` names the items in the cart not yet sent; the table's sent orders the server reads.
 */
export const RecommendationsQuery = z.strictObject({
  tableSessionId: Id.optional(),
  /** Where the suggestions will show; rules and items apply to their channels only. */
  channel: SalesChannel,
  cart: RepeatedIds,
  /** The table's veg-only filter (TAB-005). */
  vegOnly: QueryFlag,
  limit: Limit,
});
export type RecommendationsQuery = z.infer<typeof RecommendationsQuery>;

/** A table tablet's own table (AUTH-009); the channel is the tablet's. */
export const TableRecommendationsQuery = z.strictObject({
  cart: RepeatedIds,
  vegOnly: QueryFlag,
  limit: Limit,
});
export type TableRecommendationsQuery = z.infer<typeof TableRecommendationsQuery>;

// ---------------------------------------------------------------- tracking (REC-008)

/** What a diner or a waiter did with a suggestion; ORDERED is recorded by the server. */
export const RECOMMENDATION_EVENT_KINDS = ['IMPRESSION', 'TAP', 'ADD_TO_CART', 'ORDERED'] as const;
export const RecommendationEventKind = z.enum(RECOMMENDATION_EVENT_KINDS);
export type RecommendationEventKind = z.infer<typeof RecommendationEventKind>;

/** The suggestion a cart line or an event came from: its layer, and its rule for the RULE layer. */
export const RecommendationSource = z
  .strictObject({ layer: RecommendationLayer, ruleId: Id.nullable() })
  .refine((source) => (source.layer === 'RULE') === (source.ruleId !== null), {
    message: 'A rule suggestion names its rule, and only a rule suggestion does',
    path: ['ruleId'],
  });
export type RecommendationSource = z.infer<typeof RecommendationSource>;

/**
 * One thing done with a suggestion: shown (IMPRESSION), opened (TAP) or put in the cart
 * (ADD_TO_CART). An order line sent with its `recommendation` counts as ORDERED.
 */
export const RecommendationEventInput = z
  .strictObject({
    kind: RecommendationEventKind.exclude(['ORDERED']),
    itemId: Id,
    layer: RecommendationLayer,
    ruleId: Id.nullable(),
  })
  .refine((event) => (event.layer === 'RULE') === (event.ruleId !== null), {
    message: 'A rule suggestion names its rule, and only a rule suggestion does',
    path: ['ruleId'],
  });
export type RecommendationEventInput = z.infer<typeof RecommendationEventInput>;

const RecommendationEvents = z.array(RecommendationEventInput).min(1).max(50);

/** The staff side: events at a table (or a takeaway cart) on the device's channel. */
export const RecordRecommendationEventsRequest = z.strictObject({
  tableSessionId: Id.optional(),
  channel: SalesChannel,
  events: RecommendationEvents,
});
export type RecordRecommendationEventsRequest = z.infer<typeof RecordRecommendationEventsRequest>;

/** A table tablet's events, for the session open at its own table. */
export const RecordTableRecommendationEventsRequest = z.strictObject({
  events: RecommendationEvents,
});
export type RecordTableRecommendationEventsRequest = z.infer<
  typeof RecordTableRecommendationEventsRequest
>;

// ---------------------------------------------------------------- rules (REC-002)

/** An item, or a category with its sub-categories. */
export const RecommendationTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ITEM'), itemId: Id }),
  z.strictObject({ kind: z.literal('CATEGORY'), categoryId: Id }),
]);
export type RecommendationTarget = z.infer<typeof RecommendationTarget>;

/**
 * "If the order contains X, suggest Y" (REC-002), with a priority (higher first), the channels it
 * shows on, and optionally hours of the day and business dates. Pausing a rule keeps it for later.
 */
export const RecommendationRuleRequest = z
  .strictObject({
    when: RecommendationTarget,
    suggest: RecommendationTarget,
    priority: z.int().min(0).max(1_000),
    channels: z
      .array(SalesChannel)
      .min(1)
      .refine((channels) => new Set(channels).size === channels.length, {
        message: 'Each channel once',
      }),
    /** Daily, local time; end before start runs past midnight. */
    timeWindow: TimeWindow.nullable(),
    /** Business dates, both included. */
    activeFrom: IsoDate.nullable(),
    activeUntil: IsoDate.nullable(),
    /** The restaurant's own words shown with the suggestion; null for "Goes well with …". */
    label: z.string().trim().min(1).max(60).nullable(),
    active: z.boolean(),
  })
  .refine((rule) => rule.timeWindow === null || rule.timeWindow.start !== rule.timeWindow.end, {
    message: 'The hours must start and end at different times',
    path: ['timeWindow'],
  })
  .refine(
    (rule) =>
      rule.activeFrom === null || rule.activeUntil === null || rule.activeFrom <= rule.activeUntil,
    { message: 'The rule must start before it ends', path: ['activeUntil'] },
  );
export type RecommendationRuleRequest = z.infer<typeof RecommendationRuleRequest>;

export const RecommendationRuleView = z.object({
  id: Id,
  when: RecommendationTarget,
  suggest: RecommendationTarget,
  priority: z.int(),
  channels: z.array(SalesChannel),
  timeWindow: z.object({ start: z.string(), end: z.string() }).nullable(),
  activeFrom: IsoDate.nullable(),
  activeUntil: IsoDate.nullable(),
  label: z.string().nullable(),
  active: z.boolean(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type RecommendationRuleView = z.infer<typeof RecommendationRuleView>;

/** The rules not archived, highest priority first, for the rules editor (P4-03). */
export const RecommendationRuleListResponse = z.object({
  rules: z.array(RecommendationRuleView),
});
export type RecommendationRuleListResponse = z.infer<typeof RecommendationRuleListResponse>;

export const RecommendationRuleParams = z.strictObject({ ruleId: Id });
export type RecommendationRuleParams = z.infer<typeof RecommendationRuleParams>;
