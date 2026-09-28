import { Injectable } from '@nestjs/common';
import type { OrderFeedEntry, OrderFeedResponse } from '@rp/contracts';
import { LIVE_ITEM_STATES } from '@rp/domain';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MenuPublishService } from '../menu/menu-publish.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Items never made or taken back are no part of an order's progress. */
const ENDED = ['REJECTED', 'CANCELLED', 'VOIDED'] as const;
/**
 * A busy evening has far fewer live orders; the cap keeps one read bounded. Past it the newest
 * are kept, so a few forgotten old orders cannot push tonight's out of the feed.
 */
const MAX_ORDERS = 300;

const FEED_SELECT = {
  id: true,
  orderNumber: true,
  orderType: true,
  source: true,
  tableId: true,
  takeawayToken: true,
  createdById: true,
  createdAt: true,
  table: { select: { label: true } },
  tableSession: { select: { waiterId: true } },
  items: {
    where: { state: { notIn: [...ENDED] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      itemId: true,
      name: true,
      variantName: true,
      quantity: true,
      stationId: true,
      state: true,
      sentAt: true,
      preparingAt: true,
      readyAt: true,
      parent: { select: { name: true } },
      _count: { select: { components: true } },
    },
  },
} as const satisfies Prisma.OrderSelect;

type FeedRow = Prisma.OrderGetPayload<{ select: typeof FEED_SELECT }>;

function waiterOf(order: FeedRow): string | null {
  return order.tableSession?.waiterId ?? order.createdById;
}

/**
 * The manager dashboard's live order feed (P4-01, MGR-003): every order with an item waiting for
 * approval, in the kitchen or at the pass, oldest first, with each dish's station, state and
 * times. Dine-in orders leave the feed with their table (settled or closed), takeaway orders at
 * the end of their business date, whatever state their items were left in. Which items are late
 * is `@rp/domain` `itemDelay`, worked out by the screen from `settings` and `serverTime`.
 */
@Injectable()
export class OrderFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuPublishService,
    private readonly settings: SettingsService,
  ) {}

  async feed(restaurantId: string): Promise<OrderFeedResponse> {
    const now = new Date();
    const businessDate = await currentBusinessDate(this.prisma, restaurantId, now);
    const [newestFirst, stations, openSessions, snapshot, menu] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          restaurantId,
          items: { some: { state: { in: [...LIVE_ITEM_STATES] } } },
          OR: [
            { tableSession: { status: 'OPEN' } },
            { tableSessionId: null, businessDate: dbDate(businessDate) },
          ],
        },
        select: FEED_SELECT,
        orderBy: [{ createdAt: 'desc' }, { orderNumber: 'desc' }],
        take: MAX_ORDERS,
      }),
      this.prisma.station.findMany({
        where: { restaurantId },
        select: { id: true, name: true, archivedAt: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.tableSession.findMany({
        where: { restaurantId, status: 'OPEN', waiterId: { not: null } },
        select: { waiterId: true },
      }),
      this.settings.snapshot(restaurantId),
      this.menu.published(restaurantId),
    ]);
    const orders = newestFirst.reverse();

    const staffIds = new Set<string>();
    for (const session of openSessions) {
      if (session.waiterId !== null) staffIds.add(session.waiterId);
    }
    for (const order of orders) {
      const waiterId = waiterOf(order);
      if (waiterId !== null) staffIds.add(waiterId);
    }
    const staff = await this.prisma.staff.findMany({
      where: { restaurantId, id: { in: [...staffIds] } },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
    const names = new Map(staff.map((person) => [person.id, person.displayName]));
    const stationNames = new Map(stations.map((station) => [station.id, station.name]));
    const prepTimes = new Map(
      (menu?.items ?? []).map((item) => [item.id, item.prepTimeMinutes ?? null]),
    );

    return {
      orders: orders.map((order): OrderFeedEntry => {
        const waiterId = waiterOf(order);
        return {
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          source: order.source,
          tableId: order.tableId,
          tableLabel: order.table?.label ?? null,
          takeawayToken: order.takeawayToken,
          waiterId,
          waiterName: waiterId === null ? null : (names.get(waiterId) ?? null),
          createdAt: order.createdAt.toISOString(),
          items: order.items
            // The kitchen cooks a combo's parts; the combo's own line only follows them.
            .filter((item) => item._count.components === 0)
            .map((item) => ({
              orderItemId: item.id,
              name: item.name,
              variantName: item.variantName,
              quantity: item.quantity,
              comboName: item.parent?.name ?? null,
              stationId: item.stationId,
              stationName: stationNames.get(item.stationId) ?? '',
              state: item.state,
              prepTimeMinutes: prepTimes.get(item.itemId) ?? null,
              sentAt: item.sentAt?.toISOString() ?? null,
              preparingAt: item.preparingAt?.toISOString() ?? null,
              readyAt: item.readyAt?.toISOString() ?? null,
            })),
        };
      }),
      stations: stations
        .filter((station) => station.archivedAt === null)
        .map(({ id, name }) => ({ id, name })),
      waiters: staff.map((person) => ({ id: person.id, name: person.displayName })),
      settings: {
        ageRedMinutes: snapshot.get('kds.ageRedMinutes'),
        readyNotCollectedMinutes: snapshot.get('kds.readyNotCollectedMinutes'),
      },
      serverTime: now.toISOString(),
    };
  }
}
