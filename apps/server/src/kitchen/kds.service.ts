import { Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  KdsTicket,
  KdsTicketsQuery,
  KdsTicketsResponse,
  NotifyManagerResponse,
} from '@rp/contracts';
import type { OrderItemState } from '@rp/domain';
import type { Actor } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import type { Prisma } from '../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';

/** Items a station still has to cook: a ticket holding one of these cannot be bumped. */
const COOKING: ReadonlySet<OrderItemState> = new Set(['SENT', 'PREPARING']);
/** Items still at the station (waiting, cooking or ready at the pass). */
const AT_STATION: ReadonlySet<OrderItemState> = new Set(['SENT', 'PREPARING', 'READY']);
/** Recall offers tickets bumped this recently (KDS-005). */
const RECALL_WINDOW_MS = 60 * 60_000;
const RECALL_LIMIT = 20;
/** Alert type raised by "Notify manager" (KDS-006, NTF-003). */
export const READY_NOT_COLLECTED = 'READY_NOT_COLLECTED';

const TICKET_INCLUDE = {
  station: { select: { name: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      source: true,
      tableId: true,
      takeawayToken: true,
      tableSessionId: true,
      createdById: true,
      table: { select: { label: true } },
      tableSession: { select: { waiterId: true } },
    },
  },
  lines: {
    orderBy: { createdAt: 'asc' },
    include: {
      orderItem: {
        select: {
          id: true,
          name: true,
          variantName: true,
          instructions: true,
          state: true,
          readyAt: true,
          modifiers: { orderBy: { createdAt: 'asc' }, select: { name: true, quantity: true } },
          parent: { select: { name: true } },
        },
      },
    },
  },
} as const satisfies Prisma.KotInclude;

type TicketRow = Prisma.KotGetPayload<{ include: typeof TICKET_INCLUDE }>;

/**
 * The kitchen display's server side (P1-09a, KDS-001 to KDS-012): a station's open tickets with
 * each item's live state, bump and recall, and "Notify manager". A kitchen screen in station mode
 * (AUTH-005) is held to its own station; its actions are attributed to the device.
 */
@Injectable()
export class KdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async tickets(actor: Actor, query: KdsTicketsQuery): Promise<KdsTicketsResponse> {
    const stationId = this.stationFor(actor, query.stationId);
    const station =
      stationId === null
        ? null
        : await this.prisma.station.findFirst({
            where: { id: stationId, restaurantId: actor.restaurantId },
            select: { id: true, name: true },
          });
    if (stationId !== null && station === null) {
      throw new AppError(404, 'STATION_NOT_FOUND', 'There is no such station.');
    }
    const now = new Date();
    const businessDate = await currentBusinessDate(this.prisma, actor.restaurantId, now);
    const scope = {
      restaurantId: actor.restaurantId,
      ...(stationId !== null && { stationId }),
    };
    const [open, bumped, snapshot] = await Promise.all([
      this.prisma.kot.findMany({
        where: { ...scope, bumpedAt: null },
        include: TICKET_INCLUDE,
        orderBy: [{ createdAt: 'asc' }, { kotNumber: 'asc' }],
      }),
      this.prisma.kot.findMany({
        where: { ...scope, bumpedAt: { gte: new Date(now.getTime() - RECALL_WINDOW_MS) } },
        include: TICKET_INCLUDE,
        orderBy: { bumpedAt: 'desc' },
        take: RECALL_LIMIT,
      }),
      this.settings.snapshot(actor.restaurantId),
    ]);
    const today = dbDate(businessDate).getTime();
    const showing = open.filter((kot) =>
      kot.kind === 'NEW'
        ? kot.lines.some((line) => AT_STATION.has(line.orderItem.state))
        : // Change and cancellation slips stay until seen and bumped, on the day they were raised.
          kot.businessDate.getTime() >= today,
    );
    const views = await this.views(actor.restaurantId, [...showing, ...bumped]);
    return {
      station,
      tickets: views.slice(0, showing.length),
      recentlyBumped: views.slice(showing.length),
      settings: {
        ageAmberMinutes: snapshot.get('kds.ageAmberMinutes'),
        ageRedMinutes: snapshot.get('kds.ageRedMinutes'),
        readyNotCollectedMinutes: snapshot.get('kds.readyNotCollectedMinutes'),
        soundVolumePercent: snapshot.get('kds.soundVolumePercent'),
      },
      serverTime: now.toISOString(),
    };
  }

  /** Takes a finished ticket off the screen (KDS-005). Bumping twice changes nothing. */
  async bump(actor: Actor, kotId: string): Promise<KdsTicket> {
    await this.prisma.transaction(async (tx) => {
      const kot = await this.lockedTicket(tx, actor, kotId);
      if (kot.bumpedAt !== null) return;
      if (kot.kind === 'NEW' && kot.lines.some((line) => COOKING.has(line.orderItem.state))) {
        throw new AppError(
          409,
          'KOT_NOT_READY',
          'Some items on this ticket are not ready yet. Mark them ready first.',
        );
      }
      await tx.kot.update({
        where: { id: kot.id },
        data: {
          bumpedAt: new Date(),
          bumpedById: actor.staffId,
          bumpedByDeviceId: actor.deviceId,
        },
      });
      await this.emit(tx, actor.restaurantId, kot.id, {
        type: 'KotBumped',
        payload: { kotId: kot.id, stationId: kot.stationId, bumped: true },
      });
    });
    return this.view(actor.restaurantId, kotId);
  }

  /** Brings a bumped ticket back (KDS-005). */
  async recall(actor: Actor, kotId: string): Promise<KdsTicket> {
    await this.prisma.transaction(async (tx) => {
      const kot = await this.lockedTicket(tx, actor, kotId);
      if (kot.bumpedAt === null) return;
      await tx.kot.update({
        where: { id: kot.id },
        data: { bumpedAt: null, bumpedById: null, bumpedByDeviceId: null },
      });
      await this.emit(tx, actor.restaurantId, kot.id, {
        type: 'KotBumped',
        payload: { kotId: kot.id, stationId: kot.stationId, bumped: false },
      });
    });
    return this.view(actor.restaurantId, kotId);
  }

  /**
   * Ready food is not being collected: an alert for the managers (KDS-006). Pressing it again
   * while that alert is open returns it instead of raising another.
   */
  async notifyManager(actor: Actor, kotId: string): Promise<NotifyManagerResponse> {
    return this.prisma.transaction(async (tx) => {
      const kot = await this.lockedTicket(tx, actor, kotId);
      const waiting = kot.lines.filter((line) => line.orderItem.state === 'READY');
      if (waiting.length === 0) {
        throw new AppError(
          409,
          'NOTHING_WAITING',
          'Nothing on this ticket is ready and waiting to be collected.',
        );
      }
      const open = await tx.alert.findFirst({
        where: { kotId: kot.id, type: READY_NOT_COLLECTED, status: 'OPEN' },
        select: { id: true },
      });
      if (open !== null) return { alertId: open.id, alreadyOpen: true };
      const businessDate = await currentBusinessDate(tx, actor.restaurantId);
      const alert = await tx.alert.create({
        data: {
          id: newId(),
          restaurantId: actor.restaurantId,
          businessDate: dbDate(businessDate),
          type: READY_NOT_COLLECTED,
          kotId: kot.id,
          tableId: kot.order.tableId,
          raisedById: actor.staffId,
          raisedByDeviceId: actor.deviceId,
          payload: {
            kotNumber: kot.kotNumber,
            stationName: kot.station.name,
            tableLabel: kot.order.table?.label ?? null,
            takeawayToken: kot.order.takeawayToken,
            items: waiting.map((line) => line.orderItem.name),
          },
        },
      });
      // Delivery rules, acknowledgement and escalation to the managers on duty come with P2-03;
      // until then every manager's screen hears it.
      await this.emit(tx, actor.restaurantId, alert.id, {
        type: 'AlertEscalated',
        payload: { alertId: alert.id, eventType: READY_NOT_COLLECTED, escalatedTo: [] },
      });
      return { alertId: alert.id, alreadyOpen: false };
    });
  }

  /** A station-mode screen sees only its station; a person may choose one or see all. */
  private stationFor(actor: Actor, requested: string | undefined): string | null {
    const bound = actor.stationId ?? null;
    if (bound !== null) {
      if (requested !== undefined && requested !== bound) {
        throw new AppError(403, 'FORBIDDEN', 'This screen shows its own station only.');
      }
      return bound;
    }
    return requested ?? null;
  }

  private async lockedTicket(tx: TransactionClient, actor: Actor, kotId: string) {
    await tx.$queryRaw`SELECT 1 AS locked FROM kots WHERE id = ${kotId}::uuid FOR UPDATE`;
    const bound = actor.stationId ?? null;
    const kot = await tx.kot.findFirst({
      where: {
        id: kotId,
        restaurantId: actor.restaurantId,
        ...(bound !== null && { stationId: bound }),
      },
      include: TICKET_INCLUDE,
    });
    if (kot === null) {
      throw new AppError(404, 'KOT_NOT_FOUND', 'There is no such ticket at this station.');
    }
    return kot;
  }

  private async view(restaurantId: string, kotId: string): Promise<KdsTicket> {
    const kot = await this.prisma.kot.findFirstOrThrow({
      where: { id: kotId, restaurantId },
      include: TICKET_INCLUDE,
    });
    const [view] = await this.views(restaurantId, [kot]);
    if (view === undefined) throw new Error('A ticket view was not built');
    return view;
  }

  /** Ticket views with waiter names, "moved from" labels and open manager alerts, in order. */
  private async views(restaurantId: string, rows: readonly TicketRow[]): Promise<KdsTicket[]> {
    if (rows.length === 0) return [];
    const staffIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const row of rows) {
      const waiterId = row.order.tableSession?.waiterId ?? row.order.createdById;
      if (waiterId !== null) staffIds.add(waiterId);
      if (row.order.tableSessionId !== null) sessionIds.add(row.order.tableSessionId);
    }
    const [staff, moves, alerts] = await Promise.all([
      this.prisma.staff.findMany({
        where: { restaurantId, id: { in: [...staffIds] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.auditLog.findMany({
        where: {
          restaurantId,
          action: 'TABLE_MOVED',
          entityType: 'table_session',
          entityId: { in: [...sessionIds] },
        },
        select: { entityId: true, occurredAt: true, before: true },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.alert.findMany({
        where: {
          restaurantId,
          type: READY_NOT_COLLECTED,
          status: 'OPEN',
          kotId: { in: rows.map((row) => row.id) },
        },
        select: { kotId: true },
      }),
    ]);
    const names = new Map(staff.map((person) => [person.id, person.displayName]));
    const notified = new Set(alerts.map((alert) => alert.kotId));
    const movedFrom = (row: TicketRow): string | null => {
      // The first move after the ticket was raised: the kitchen knew the table by that label.
      const move = moves.find(
        (entry) => entry.entityId === row.order.tableSessionId && entry.occurredAt >= row.createdAt,
      );
      const before = move?.before;
      if (typeof before !== 'object' || before === null || !('tableLabel' in before)) return null;
      return typeof before.tableLabel === 'string' ? before.tableLabel : null;
    };
    return rows.map((row) => {
      const waiterId = row.order.tableSession?.waiterId ?? row.order.createdById;
      return {
        kotId: row.id,
        kotNumber: row.kotNumber,
        kind: row.kind,
        stationId: row.stationId,
        stationName: row.station.name,
        orderId: row.order.id,
        orderNumber: row.order.orderNumber,
        tableLabel: row.order.table?.label ?? null,
        takeawayToken: row.order.takeawayToken,
        movedFrom: movedFrom(row),
        waiterName: waiterId === null ? null : (names.get(waiterId) ?? null),
        source: row.order.source,
        createdAt: row.createdAt.toISOString(),
        bumpedAt: row.bumpedAt?.toISOString() ?? null,
        managerNotified: notified.has(row.id),
        lines: row.lines.map((line) => ({
          orderItemId: line.orderItem.id,
          quantity: line.quantity,
          name: line.orderItem.name,
          variantName: line.orderItem.variantName,
          modifiers: line.orderItem.modifiers.map((modifier) =>
            modifier.quantity > 1
              ? `${String(modifier.quantity)} × ${modifier.name}`
              : modifier.name,
          ),
          instructions: line.orderItem.instructions,
          comboName: line.orderItem.parent?.name ?? null,
          state: line.orderItem.state,
          readyAt: line.orderItem.readyAt?.toISOString() ?? null,
        })),
      };
    });
  }

  private async emit(
    tx: TransactionClient,
    restaurantId: string,
    aggregateId: string,
    event: Pick<DomainEvent, 'type' | 'payload'>,
  ): Promise<void> {
    await appendEvent(
      tx,
      {
        eventId: newId(),
        version: 1,
        occurredAt: new Date().toISOString(),
        restaurantId,
        businessDate: await currentBusinessDate(tx, restaurantId),
        ...event,
      } as DomainEvent,
      { aggregate: { type: event.type === 'AlertEscalated' ? 'alert' : 'kot', id: aggregateId } },
    );
  }
}
