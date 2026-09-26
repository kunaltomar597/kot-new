import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  AlertListResponse,
  AlertView,
  DomainEvent,
  NotificationEventType,
} from '@rp/contracts';
import {
  dueActions,
  effectiveRule,
  initialDeadlines,
  type NotificationEvent,
  type NotificationRule,
  type NotificationTiming,
  pagerTextFor,
  resolveRecipients,
} from '@rp/domain';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import type { Alert } from '../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  NOTIFICATION_CLOCK,
  NOTIFICATION_OPTIONS,
  type NotificationClock,
  type NotificationOptions,
} from './clock.js';
import { PRESENCE, type Presence } from './presence.js';
import { recipientContext } from './recipients.js';

export interface RaiseAlert {
  readonly restaurantId: string;
  readonly type: NotificationEvent;
  readonly tableId?: string | null;
  readonly tableSessionId?: string | null;
  readonly orderId?: string | null;
  readonly kotId?: string | null;
  /** One open alert per cause: raising it again while it is open returns the open one. */
  readonly dedupeKey?: string | null;
  readonly payload?: Record<string, unknown>;
  /** A nudge's text (NTF-008). */
  readonly message?: string | null;
  readonly selectedIds?: readonly string[];
  readonly wearerId?: string | null;
  readonly stationIds?: readonly string[];
  readonly raisedById?: string | null;
  readonly raisedByDeviceId?: string | null;
}

const MANAGER_ROLES = new Set(['OWNER', 'MANAGER']);

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toAlertView(alert: Alert): AlertView {
  return {
    id: alert.id,
    type: alert.type as NotificationEventType,
    status: alert.status,
    tableId: alert.tableId,
    tableSessionId: alert.tableSessionId,
    orderId: alert.orderId,
    pagerText: alert.pagerText,
    payload:
      typeof alert.payload === 'object' && alert.payload !== null && !Array.isArray(alert.payload)
        ? alert.payload
        : {},
    recipientIds: alert.recipientIds,
    channels: alert.channels,
    repeatCount: alert.repeatCount,
    escalatedAt: iso(alert.escalatedAt),
    escalatedTo: alert.escalatedTo,
    createdAt: alert.createdAt.toISOString(),
    acknowledgedAt: iso(alert.acknowledgedAt),
    acknowledgedById: alert.acknowledgedById,
    clearedAt: iso(alert.clearedAt),
  };
}

/**
 * The notification engine (P2-03, NTF-001 to NTF-007, BRD Appendix C). An alert is written with
 * its recipients and its deadlines (escalate at, next repeat at), in the transaction of the change
 * that caused it, and delivered as `AlertRaised` through the outbox to each recipient's devices.
 * A ticker looks for due deadlines, so repeats and escalations survive a restart. Acknowledging on
 * any device acknowledges everywhere; the cause going away clears it.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
    @Inject(PRESENCE) private readonly presence: Presence,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.tickMs <= 0) return;
    this.timer = setInterval(() => {
      this.running ??= this.processDue()
        .catch((error: unknown) => {
          this.logger.error(`Notification tick failed: ${String(error)}`);
        })
        .finally(() => {
          this.running = undefined;
        });
    }, this.options.tickMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Raises an alert inside the caller's transaction. */
  async raise(
    tx: TransactionClient,
    input: RaiseAlert,
  ): Promise<{ alertId: string; alreadyOpen: boolean }> {
    const { restaurantId } = input;
    if (input.dedupeKey !== undefined && input.dedupeKey !== null) {
      const open = await tx.alert.findFirst({
        where: { restaurantId, dedupeKey: input.dedupeKey, status: 'OPEN' },
        select: { id: true },
      });
      if (open !== null) return { alertId: open.id, alreadyOpen: true };
    }
    const now = this.clock.now();
    const { rule, timing } = await this.ruleFor(restaurantId, input.type);
    const businessDate = await currentBusinessDate(tx, restaurantId, now);
    const tableId = input.tableId ?? null;
    const table =
      tableId === null
        ? null
        : await tx.diningTable.findUnique({ where: { id: tableId }, select: { label: true } });
    const context = await recipientContext(
      tx,
      {
        restaurantId,
        businessDate,
        tableId,
        tableSessionId: input.tableSessionId ?? null,
        ...(input.selectedIds !== undefined && { selectedIds: input.selectedIds }),
        ...(input.wearerId !== undefined && { wearerId: input.wearerId }),
      },
      now,
      (staffId) => this.presence.reachable(restaurantId, staffId),
    );
    const resolved = resolveRecipients(rule, context);
    const deadlines = initialDeadlines(rule, now, timing, resolved.escalateNow);
    const pagerText = pagerTextFor(rule.pagerText, {
      table: table?.label ?? null,
      message: input.message ?? null,
    });
    const alert = await tx.alert.create({
      data: {
        id: newId(),
        restaurantId,
        businessDate: dbDate(businessDate),
        type: input.type,
        kotId: input.kotId ?? null,
        tableId,
        tableSessionId: input.tableSessionId ?? null,
        orderId: input.orderId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        raisedById: input.raisedById ?? null,
        raisedByDeviceId: input.raisedByDeviceId ?? null,
        payload: { ...input.payload, ...(input.message ? { message: input.message } : {}) },
        recipientIds: [...resolved.staffIds],
        channels: [...rule.channels],
        pagerText,
        escalateAt: deadlines.escalateAt,
        nextRepeatAt: deadlines.nextRepeatAt,
        escalatedAt: resolved.escalateNow ? now : null,
        escalatedTo: resolved.escalateNow ? [...context.managersOnDuty] : [],
        createdAt: now,
      },
    });
    const stationIds = resolved.stations ? [...(input.stationIds ?? [])] : [];
    await this.emit(
      tx,
      alert,
      now,
      {
        type: 'AlertRaised',
        payload: {
          alertId: alert.id,
          eventType: alert.type,
          recipients: alert.recipientIds,
          pagerText,
          tableId,
          repeat: 0,
          escalated: resolved.escalateNow,
        },
      },
      stationIds,
    );
    if (resolved.escalateNow) {
      await this.emit(tx, alert, now, {
        type: 'AlertEscalated',
        payload: { alertId: alert.id, eventType: alert.type, escalatedTo: alert.escalatedTo },
      });
    }
    return { alertId: alert.id, alreadyOpen: false };
  }

  /** Clears the open alerts that match (the cause went away). */
  async clear(
    tx: TransactionClient,
    where: { restaurantId: string; dedupeKey?: string; tableSessionId?: string; ids?: string[] },
  ): Promise<number> {
    const open = await tx.alert.findMany({
      where: {
        restaurantId: where.restaurantId,
        status: 'OPEN',
        ...(where.dedupeKey !== undefined && { dedupeKey: where.dedupeKey }),
        ...(where.tableSessionId !== undefined && { tableSessionId: where.tableSessionId }),
        ...(where.ids !== undefined && { id: { in: where.ids } }),
      },
    });
    const now = this.clock.now();
    for (const alert of open) {
      const cleared = await tx.alert.update({
        where: { id: alert.id },
        data: { status: 'CLEARED', clearedAt: now, escalateAt: null, nextRepeatAt: null },
      });
      await this.emit(tx, cleared, now, {
        type: 'AlertCleared',
        payload: { alertId: alert.id, recipients: alert.recipientIds },
      });
    }
    return open.length;
  }

  async list(principal: Principal): Promise<AlertListResponse> {
    const alerts = await this.prisma.alert.findMany({
      where: {
        restaurantId: principal.restaurantId,
        status: 'OPEN',
        ...(!MANAGER_ROLES.has(principal.role) && { recipientIds: { has: principal.staffId } }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return { alerts: alerts.map(toAlertView) };
  }

  /** NTF-004: acknowledged by a recipient, a manager or the Owner, on any device. */
  async acknowledge(principal: Principal, alertId: string): Promise<AlertView> {
    return this.prisma.transaction(async (tx) => {
      const [alert] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM alerts WHERE id = ${alertId}::uuid AND restaurant_id = ${principal.restaurantId}::uuid
        FOR UPDATE`;
      const row =
        alert === undefined ? null : await tx.alert.findUnique({ where: { id: alert.id } });
      if (
        row === null ||
        (!MANAGER_ROLES.has(principal.role) && !row.recipientIds.includes(principal.staffId))
      ) {
        throw new AppError(404, 'ALERT_NOT_FOUND', 'There is no such alert for you.');
      }
      if (row.status !== 'OPEN') return toAlertView(row);
      const now = this.clock.now();
      const acknowledged = await tx.alert.update({
        where: { id: row.id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedAt: now,
          acknowledgedById: principal.staffId,
          escalateAt: null,
          nextRepeatAt: null,
        },
      });
      await this.emit(tx, acknowledged, now, {
        type: 'AlertAcknowledged',
        payload: {
          alertId: row.id,
          acknowledgedBy: principal.staffId,
          recipients: row.recipientIds,
        },
      });
      return toAlertView(acknowledged);
    });
  }

  /**
   * Escalations and repeats that are due (NTF-002, NTF-005). Each alert is handled in its own
   * transaction with its row locked, so two servers or ticks never repeat it twice.
   */
  async processDue(now: Date = this.clock.now()): Promise<number> {
    const due = await this.prisma.alert.findMany({
      where: {
        status: 'OPEN',
        OR: [{ escalateAt: { lte: now } }, { nextRepeatAt: { lte: now } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    let handled = 0;
    for (const { id } of due) {
      const done = await this.prisma.transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM alerts WHERE id = ${id}::uuid AND status = 'OPEN' FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return false;
        const alert = await tx.alert.findUniqueOrThrow({ where: { id } });
        return this.advance(tx, alert, now);
      });
      if (done) handled += 1;
    }
    return handled;
  }

  private async advance(tx: TransactionClient, alert: Alert, now: Date): Promise<boolean> {
    const { rule, timing } = await this.ruleFor(
      alert.restaurantId,
      alert.type as NotificationEvent,
    );
    const actions = dueActions(
      rule,
      { escalateAt: alert.escalateAt, nextRepeatAt: alert.nextRepeatAt },
      now,
      timing,
    );
    if (actions.length === 0) return false;
    let recipients = alert.recipientIds;
    let escalatedTo = alert.escalatedTo;
    let escalatedAt = alert.escalatedAt;
    let repeatCount = alert.repeatCount;
    for (const action of actions) {
      if (action.kind === 'ESCALATE') {
        const context = await recipientContext(
          tx,
          {
            restaurantId: alert.restaurantId,
            businessDate: isoDateOf(alert.businessDate),
            tableId: alert.tableId,
            tableSessionId: alert.tableSessionId,
          },
          now,
          (staffId) => this.presence.reachable(alert.restaurantId, staffId),
        );
        escalatedTo = [...context.managersOnDuty];
        escalatedAt = now;
        recipients = [...new Set([...recipients, ...escalatedTo])];
      } else {
        repeatCount += 1;
      }
    }
    const last = actions.at(-1);
    const updated = await tx.alert.update({
      where: { id: alert.id },
      data: {
        recipientIds: recipients,
        escalatedTo,
        escalatedAt,
        repeatCount,
        escalateAt: last?.next.escalateAt ?? null,
        nextRepeatAt: last?.next.nextRepeatAt ?? null,
      },
    });
    if (actions.some((action) => action.kind === 'ESCALATE')) {
      await this.emit(tx, updated, now, {
        type: 'AlertEscalated',
        payload: { alertId: alert.id, eventType: alert.type, escalatedTo },
      });
    }
    await this.emit(tx, updated, now, {
      type: 'AlertRaised',
      payload: {
        alertId: alert.id,
        eventType: alert.type,
        recipients,
        pagerText: alert.pagerText,
        tableId: alert.tableId,
        repeat: repeatCount,
        escalated: escalatedAt !== null,
      },
    });
    return true;
  }

  private async ruleFor(
    restaurantId: string,
    type: NotificationEvent,
  ): Promise<{ rule: NotificationRule; timing: NotificationTiming }> {
    const settings = await this.settings.snapshot(restaurantId);
    return {
      rule: effectiveRule(type, settings.get('notifications.rules')),
      timing: {
        escalationSeconds: settings.get('notifications.escalationSeconds'),
        repeatSeconds: settings.get('notifications.repeatSeconds'),
      },
    };
  }

  private async emit(
    tx: TransactionClient,
    alert: Alert,
    now: Date,
    event: Pick<
      Extract<
        DomainEvent,
        { type: 'AlertRaised' | 'AlertAcknowledged' | 'AlertCleared' | 'AlertEscalated' }
      >,
      'type' | 'payload'
    >,
    stationIds: readonly string[] = [],
  ): Promise<void> {
    await appendEvent(
      tx,
      {
        eventId: newId(),
        version: 1,
        occurredAt: now.toISOString(),
        restaurantId: alert.restaurantId,
        businessDate: isoDateOf(alert.businessDate),
        ...event,
      } as DomainEvent,
      {
        aggregate: { type: 'alert', id: alert.id },
        audience: {
          staffIds: [...alert.recipientIds],
          ...(stationIds.length > 0 && { stationIds: [...stationIds] }),
        },
      },
    );
  }
}
