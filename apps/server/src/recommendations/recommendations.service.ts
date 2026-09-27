import { Inject, Injectable } from '@nestjs/common';
import type { RecommendationEventInput, RecommendationsResponse } from '@rp/contracts';
import { daypartAt, type RecoChannel, type RecoItem, recommend, timeOfDayOf } from '@rp/domain';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { comboOnNow } from '../menu/menu-content.js';
import { MenuPublishService } from '../menu/menu-publish.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BestSellers } from './best-sellers.js';
import { RECOMMENDATION_CLOCK, type RecommendationClock } from './clock.js';
import { RecommendationRulesService } from './recommendation-rules.service.js';

const errors = {
  notATablet: () =>
    new AppError(
      403,
      'NOT_A_TABLE_TABLET',
      'Only a table tablet bound to a table can show suggestions for its table.',
    ),
  tableNotOpen: () =>
    new AppError(409, 'TABLE_NOT_OPEN', 'This table is not open yet. Please ask a waiter.'),
  sessionNotFound: () =>
    new AppError(404, 'TABLE_SESSION_NOT_FOUND', 'There is no such table session.'),
  sessionClosed: () =>
    new AppError(409, 'TABLE_SESSION_CLOSED', 'This table has been closed. Open it again first.'),
  unknown: (details: { itemIds: string[]; ruleIds: string[] }) =>
    new AppError(
      422,
      'RECOMMENDATION_UNKNOWN',
      'Some suggestions named items or rules this restaurant does not have.',
      details,
    ),
};

/** Order lines that never reached the table: they are not "in the order" (REC-005). */
const ENDED_STATES = ['REJECTED', 'CANCELLED', 'VOIDED'] as const;

interface Ask {
  readonly restaurantId: string;
  readonly tableSessionId: string | null;
  readonly channel: RecoChannel;
  readonly cart: readonly string[];
  readonly vegOnly: boolean;
  readonly limit: number;
}

interface Tracked {
  readonly restaurantId: string;
  readonly tableSessionId: string | null;
  readonly channel: RecoChannel;
  readonly deviceId: string;
  readonly staffId: string | null;
  readonly events: readonly RecommendationEventInput[];
}

/**
 * Serves recommendations (P3-04, REC-001, REC-011): loads what `@rp/domain` `recommend` needs (the
 * published menu with live availability, the active rules, the best sellers of the time of day,
 * the table's order and cart) and returns its suggestions with their reasons. Table-level only
 * (REC-007): nothing about a person is read. Also records what was done with them (REC-008).
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuPublishService,
    private readonly settings: SettingsService,
    private readonly rules: RecommendationRulesService,
    private readonly bestSellers: BestSellers,
    @Inject(RECOMMENDATION_CLOCK) private readonly clock: RecommendationClock,
  ) {}

  /** The waiter app and the POS: a table's suggestions, or a takeaway cart's (WTR-011). */
  async forStaff(
    principal: Principal,
    query: {
      tableSessionId?: string;
      channel: RecoChannel;
      cart: string[];
      vegOnly: boolean;
      limit: number;
    },
  ): Promise<RecommendationsResponse> {
    let tableSessionId: string | null = null;
    if (query.tableSessionId !== undefined) {
      const session = await this.sessionOf(principal.restaurantId, query.tableSessionId);
      if (session.status !== 'OPEN') throw errors.sessionClosed();
      tableSessionId = session.id;
    }
    return this.suggest({
      restaurantId: principal.restaurantId,
      tableSessionId,
      channel: query.channel,
      cart: query.cart,
      vegOnly: query.vegOnly,
      limit: query.limit,
    });
  }

  /** A table tablet's own table (TAB-011, AUTH-009). */
  async forTablet(
    device: AuthenticatedDevice,
    query: { cart: string[]; vegOnly: boolean; limit: number },
  ): Promise<RecommendationsResponse> {
    const tableSessionId = await this.openSessionAt(device);
    return this.suggest({
      restaurantId: device.restaurantId,
      tableSessionId,
      channel: 'TABLE_TABLET',
      cart: query.cart,
      vegOnly: query.vegOnly,
      limit: query.limit,
    });
  }

  /** Suggestions shown, opened and put in the cart on a staff device (REC-008). */
  async trackForStaff(
    principal: Principal,
    request: { tableSessionId?: string; channel: RecoChannel; events: RecommendationEventInput[] },
  ): Promise<void> {
    // Events sent in batches may arrive after the table closed: they still count.
    const session =
      request.tableSessionId === undefined
        ? null
        : await this.sessionOf(principal.restaurantId, request.tableSessionId);
    await this.track({
      restaurantId: principal.restaurantId,
      tableSessionId: session?.id ?? null,
      channel: request.channel,
      deviceId: principal.deviceId,
      staffId: principal.staffId,
      events: request.events,
    });
  }

  /** A table tablet's, for the session open at its table (AUTH-009). */
  async trackForTablet(
    device: AuthenticatedDevice,
    events: RecommendationEventInput[],
  ): Promise<void> {
    const tableSessionId = await this.openSessionAt(device);
    await this.track({
      restaurantId: device.restaurantId,
      tableSessionId,
      channel: 'TABLE_TABLET',
      deviceId: device.deviceId,
      staffId: null,
      events,
    });
  }

  private async suggest(ask: Ask): Promise<RecommendationsResponse> {
    const now = this.clock.now();
    const { restaurantId } = ask;
    const [menu, settings, restaurant, businessDate, ordered, rules] = await Promise.all([
      this.menu.current(restaurantId),
      this.settings.snapshot(restaurantId),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: restaurantId },
        select: { timeZone: true },
      }),
      currentBusinessDate(this.prisma, restaurantId, now),
      ask.tableSessionId === null ? [] : this.orderedAt(ask.tableSessionId),
      this.rules.active(restaurantId),
    ]);
    const { timeZone } = restaurant;
    const time = timeOfDayOf(now, timeZone);
    const dayparts = settings.get('reco.dayparts');
    const daypart = daypartAt(time, dayparts);
    const bestSellers = await this.bestSellers.get({
      restaurantId,
      businessDate,
      days: settings.get('reco.bestSellerDays'),
      hours: daypart === null ? null : dayparts[daypart],
      timeZone,
    });
    // A combo outside its dates or hours cannot be ordered now, so it is not suggested either.
    const combosOff = new Set(
      menu.combos.filter((combo) => !comboOnNow(combo, now, timeZone)).map((combo) => combo.itemId),
    );
    const items: RecoItem[] = menu.items.map((item) => ({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      foodType: item.foodType,
      available: item.available && !combosOff.has(item.id),
      stockCount: item.stockCount,
      channels: item.channels,
      repeatable: item.repeatable,
      archived: item.archived,
    }));
    const recommendations = recommend({
      items,
      categories: menu.categories,
      rules,
      bestSellers,
      daypart,
      channel: ask.channel,
      ordered: [...ordered, ...ask.cart],
      vegOnly: ask.vegOnly,
      time,
      businessDate,
      courseSequence: settings.get('reco.courseSequence'),
      limit: ask.limit,
    });
    return { recommendations, daypart, menuVersion: menu.version };
  }

  /** The items in a table's orders that are sent or waiting for approval, combo parts too. */
  private async orderedAt(tableSessionId: string): Promise<string[]> {
    const lines = await this.prisma.orderItem.findMany({
      where: { order: { tableSessionId }, state: { notIn: [...ENDED_STATES] } },
      select: { itemId: true },
      distinct: ['itemId'],
    });
    return lines.map((line) => line.itemId);
  }

  private async track(tracked: Tracked): Promise<void> {
    const { restaurantId } = tracked;
    const itemIds = [...new Set(tracked.events.map((event) => event.itemId))];
    const ruleIds = [
      ...new Set(tracked.events.flatMap((event) => (event.ruleId === null ? [] : [event.ruleId]))),
    ];
    const [items, rules, businessDate] = await Promise.all([
      this.prisma.item.findMany({
        where: { restaurantId, id: { in: itemIds } },
        select: { id: true },
      }),
      this.prisma.recommendationRule.findMany({
        where: { restaurantId, id: { in: ruleIds } },
        select: { id: true },
      }),
      currentBusinessDate(this.prisma, restaurantId, this.clock.now()),
    ]);
    const knownItems = new Set(items.map((item) => item.id));
    const knownRules = new Set(rules.map((rule) => rule.id));
    const unknown = {
      itemIds: itemIds.filter((id) => !knownItems.has(id)),
      ruleIds: ruleIds.filter((id) => !knownRules.has(id)),
    };
    if (unknown.itemIds.length > 0 || unknown.ruleIds.length > 0) throw errors.unknown(unknown);
    await this.prisma.recommendationEvent.createMany({
      data: tracked.events.map((event) => ({
        id: newId(),
        restaurantId,
        businessDate: dbDate(businessDate),
        kind: event.kind,
        layer: event.layer,
        itemId: event.itemId,
        ruleId: event.ruleId,
        channel: tracked.channel,
        tableSessionId: tracked.tableSessionId,
        deviceId: tracked.deviceId,
        staffId: tracked.staffId,
      })),
    });
  }

  private async sessionOf(restaurantId: string, tableSessionId: string) {
    const session = await this.prisma.tableSession.findFirst({
      where: { id: tableSessionId, restaurantId },
      select: { id: true, status: true },
    });
    if (session === null) throw errors.sessionNotFound();
    return session;
  }

  /** The session open at a table tablet's own table (AUTH-009). */
  private async openSessionAt(device: AuthenticatedDevice): Promise<string> {
    if (device.type !== 'TABLE_TABLET' || device.tableId === null) throw errors.notATablet();
    const session = await this.prisma.tableSession.findFirst({
      where: { restaurantId: device.restaurantId, tableId: device.tableId, status: 'OPEN' },
      select: { id: true },
    });
    if (session === null) throw errors.tableNotOpen();
    return session.id;
  }
}
