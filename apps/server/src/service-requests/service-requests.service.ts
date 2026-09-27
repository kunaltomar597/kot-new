import { Inject, Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  ServiceRequestListResponse,
  ServiceRequestSource,
  ServiceRequestView,
  TableServiceRequestsResponse,
} from '@rp/contracts';
import {
  canRaiseServiceRequest,
  canTransition,
  cancelButtonEvent,
  OPEN_SERVICE_REQUEST_STATES,
  resolveEvents,
  SERVICE_REQUEST_ALERTS,
  serviceRequestMachine,
  type ServiceRequestEvent,
  type ServiceRequestState,
  type ServiceRequestType,
  tableMachine,
  transition,
} from '@rp/domain';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import type { ServiceRequest } from '../generated/prisma/client.js';
import { NOTIFICATION_CLOCK, type NotificationClock } from '../notifications/clock.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';

const OPEN_STATES = [...OPEN_SERVICE_REQUEST_STATES];

const errors = {
  notATablet: () =>
    new AppError(
      403,
      'NOT_A_TABLE_TABLET',
      'Only a table tablet bound to a table can call a waiter from the table.',
    ),
  tableNotOpen: () =>
    new AppError(409, 'TABLE_NOT_OPEN', 'This table is not open yet. Please ask a waiter.'),
  alreadyActive: (serviceRequestId: string | undefined) =>
    new AppError(
      409,
      'SERVICE_REQUEST_ACTIVE',
      'This request is already with the waiter. It stays on until it is cancelled or resolved.',
      serviceRequestId === undefined ? undefined : { serviceRequestId },
    ),
  notFound: () =>
    new AppError(404, 'SERVICE_REQUEST_NOT_FOUND', 'There is no such service request.'),
  rateLimited: () =>
    new AppError(
      429,
      'RATE_LIMITED',
      'Too many requests from this table. Wait a minute and try again, or wave to a waiter.',
    ),
};

type RequestEvent = Extract<
  DomainEvent,
  {
    type:
      | 'ServiceRequestRaised'
      | 'ServiceRequestEscalated'
      | 'ServiceRequestAcknowledged'
      | 'ServiceRequestCancelled'
      | 'BillRequested'
      | 'TableStateChanged';
  }
>;
type EventInput = {
  [T in RequestEvent['type']]: { type: T; payload: Extract<RequestEvent, { type: T }>['payload'] };
}[RequestEvent['type']];

/** A request with what its view needs: the session's table now and who acknowledged it. */
type RequestRow = ServiceRequest & {
  tableSession: { table: { id: string; label: string } };
};

const WITH_TABLE = { tableSession: { select: { table: { select: { id: true, label: true } } } } };

/**
 * Service requests (P2-06d; TAB-004, WTR-005, BILL-015, NTF-003 to NTF-005, SEC-009): a diner's
 * Water, Waiter or Bill from the table tablet (the QR page later). Each follows `@rp/domain`
 * `serviceRequestMachine` and raises its alert in the same transaction; the alert repeats every R
 * and escalates after N (the notification engine). Acknowledging the alert anywhere (pager, phone,
 * POS) acknowledges the request (`ServiceRequestAlerts`), and closing the request clears its alert.
 */
@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly limiter: RateLimiter,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
  ) {}

  /** The waiter's inbox (WTR-005): every open request, oldest first. */
  async list(restaurantId: string): Promise<ServiceRequestListResponse> {
    const rows = await this.prisma.serviceRequest.findMany({
      where: { restaurantId, state: { in: OPEN_STATES } },
      include: WITH_TABLE,
      orderBy: { createdAt: 'asc' },
    });
    return { requests: await this.views(this.prisma, rows) };
  }

  /** A table tablet's own open requests (AUTH-009): those of the session open at its table. */
  async listForTablet(device: AuthenticatedDevice): Promise<TableServiceRequestsResponse> {
    const tableId = this.tableOf(device);
    const session = await this.prisma.tableSession.findFirst({
      where: { restaurantId: device.restaurantId, tableId, status: 'OPEN' },
      select: { id: true },
    });
    if (session === null) return { tableSessionId: null, requests: [] };
    const rows = await this.prisma.serviceRequest.findMany({
      where: { tableSessionId: session.id, state: { in: OPEN_STATES } },
      include: WITH_TABLE,
      orderBy: { createdAt: 'asc' },
    });
    return { tableSessionId: session.id, requests: await this.views(this.prisma, rows) };
  }

  /** Water, Waiter or Bill pressed on the table tablet (TAB-004). */
  async raiseFromTablet(
    device: AuthenticatedDevice,
    type: ServiceRequestType,
  ): Promise<ServiceRequestView> {
    const tableId = this.tableOf(device);
    const settings = await this.settings.snapshot(device.restaurantId);
    const limit = settings.get('tablet.serviceRequestsPerMinute');
    if (!this.limiter.attempt(`service-request:${device.deviceId}`, limit, 60_000)) {
      throw errors.rateLimited();
    }
    return this.raise({
      restaurantId: device.restaurantId,
      tableId,
      type,
      source: 'TABLE_TABLET',
      deviceId: device.deviceId,
    });
  }

  /**
   * Raises a request at a table and its alert, in one transaction with the table row locked, so two
   * presses at once cannot both get through the anti-spam check. A Bill also sets the table to
   * Bill requested (BILL-015) and tells the cashier through its alert.
   */
  private raise(input: {
    restaurantId: string;
    tableId: string;
    type: ServiceRequestType;
    source: ServiceRequestSource;
    deviceId: string | null;
  }): Promise<ServiceRequestView> {
    const { restaurantId, tableId, type } = input;
    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${tableId}::uuid FOR UPDATE`;
      const session = await tx.tableSession.findFirst({
        where: { restaurantId, tableId, status: 'OPEN' },
        include: { table: true },
      });
      if (session === null) throw errors.tableNotOpen();
      const open = await tx.serviceRequest.findMany({
        where: { tableSessionId: session.id, state: { in: OPEN_STATES } },
        select: { id: true, type: true, state: true },
      });
      if (!canRaiseServiceRequest(type, open)) {
        throw errors.alreadyActive(open.find((request) => request.type === type)?.id);
      }
      const now = this.clock.now();
      const businessDate = await currentBusinessDate(tx, restaurantId, now);
      const id = newId();
      await tx.serviceRequest.create({
        data: {
          id,
          restaurantId,
          businessDate: dbDate(businessDate),
          tableSessionId: session.id,
          tableId,
          type,
          source: input.source,
          raisedByDeviceId: input.deviceId,
          createdAt: now,
        },
      });
      const events: EventInput[] = [
        { type: 'ServiceRequestRaised', payload: { serviceRequestId: id, tableId, type } },
      ];
      if (type === 'BILL') {
        if (canTransition(tableMachine, session.table.state, 'REQUEST_BILL')) {
          const state = transition(tableMachine, session.table.state, 'REQUEST_BILL').to;
          await tx.diningTable.update({ where: { id: tableId }, data: { state } });
          events.push({ type: 'TableStateChanged', payload: { tableId, state } });
        }
        events.push({
          type: 'BillRequested',
          payload: { tableSessionId: session.id, requestedFrom: input.source },
        });
      }
      const { alertId } = await this.notifications.raise(tx, {
        restaurantId,
        type: SERVICE_REQUEST_ALERTS[type],
        tableId,
        tableSessionId: session.id,
        dedupeKey: `service:${id}`,
        payload: { serviceRequestId: id, requestedFrom: input.source },
        raisedByDeviceId: input.deviceId,
      });
      const row = await tx.serviceRequest.update({
        where: { id },
        data: { alertId },
        include: WITH_TABLE,
      });
      await this.emit(tx, row, businessDate, events);
      return this.viewOf(tx, row);
    });
  }

  /** "On my way" from the waiter's inbox (WTR-005): the request and its alert, everywhere. */
  acknowledge(principal: Principal, requestId: string): Promise<ServiceRequestView> {
    return this.prisma.transaction(async (tx) => {
      const row = await this.lock(tx, principal.restaurantId, requestId);
      if (row === null) throw errors.notFound();
      if (!canTransition(serviceRequestMachine, row.state, 'ACKNOWLEDGE')) {
        return this.viewOf(tx, row);
      }
      const updated = await this.apply(tx, row, ['ACKNOWLEDGE'], { staffId: principal.staffId });
      return this.viewOf(tx, updated);
    });
  }

  /** Resolve in the waiter's inbox (WTR-005): cleared like Cancel on the tablet, as dealt with. */
  resolve(principal: Principal, requestId: string): Promise<ServiceRequestView> {
    return this.prisma.transaction(async (tx) => {
      const row = await this.lock(tx, principal.restaurantId, requestId);
      if (row === null) throw errors.notFound();
      const updated = await this.apply(tx, row, resolveEvents(row.state), {
        staffId: principal.staffId,
      });
      return this.viewOf(tx, updated);
    });
  }

  /**
   * Cancel on the table tablet (TAB-004), like a cabin call button: not yet acknowledged, the diner
   * no longer needs it; acknowledged, the waiter has arrived. Only its own table's requests.
   */
  cancelFromTablet(device: AuthenticatedDevice, requestId: string): Promise<ServiceRequestView> {
    const tableId = this.tableOf(device);
    return this.prisma.transaction(async (tx) => {
      const row = await this.lock(tx, device.restaurantId, requestId);
      if (row === null) throw errors.notFound();
      const session = await tx.tableSession.findUnique({
        where: { id: row.tableSessionId },
        select: { tableId: true, status: true },
      });
      if (session?.tableId !== tableId || session.status !== 'OPEN') throw errors.notFound();
      const event = cancelButtonEvent(row.state);
      const updated =
        event === undefined
          ? row
          : await this.apply(tx, row, [event], { deviceId: device.deviceId });
      return this.viewOf(tx, updated);
    });
  }

  /**
   * The request's alert was acknowledged elsewhere: on a pager, a phone's notification or the POS
   * alert centre (NTF-004). The tablet then shows "Waiter is on the way".
   */
  async alertAcknowledged(
    tx: TransactionClient,
    alertId: string,
    acknowledgedBy: string | null,
  ): Promise<void> {
    const row = await this.lockByAlert(tx, alertId);
    if (row === null || !canTransition(serviceRequestMachine, row.state, 'ACKNOWLEDGE')) return;
    await this.apply(tx, row, ['ACKNOWLEDGE'], { staffId: acknowledgedBy });
  }

  /** Nobody acknowledged within N seconds: the managers were called (NTF-005). */
  async alertEscalated(tx: TransactionClient, alertId: string): Promise<void> {
    const row = await this.lockByAlert(tx, alertId);
    if (row === null || !canTransition(serviceRequestMachine, row.state, 'ESCALATE')) return;
    await this.apply(tx, row, ['ESCALATE'], {});
  }

  /**
   * The table closed (paid, or closed without a bill): its open requests end as a Cancel on the
   * tablet would end them, so nothing stays on for the next guests.
   */
  async tableClosed(tx: TransactionClient, tableSessionId: string): Promise<void> {
    const open = await tx.serviceRequest.findMany({
      where: { tableSessionId, state: { in: OPEN_STATES } },
      select: { id: true, restaurantId: true },
    });
    for (const { id, restaurantId } of open) {
      const row = await this.lock(tx, restaurantId, id);
      const event = row === null ? undefined : cancelButtonEvent(row.state);
      if (row !== null && event !== undefined) await this.apply(tx, row, [event], {});
    }
  }

  /**
   * Moves a request through `events` (each checked by the machine), keeping its alert in step:
   * acknowledging acknowledges the alert, cancelling clears it. Emits the request's events.
   */
  private async apply(
    tx: TransactionClient,
    row: RequestRow,
    events: readonly ServiceRequestEvent[],
    by: { staffId?: string | null; deviceId?: string },
  ): Promise<RequestRow> {
    if (events.length === 0) return row;
    const now = this.clock.now();
    let state: ServiceRequestState = row.state;
    const data: Partial<ServiceRequest> = {};
    const out: EventInput[] = [];
    for (const event of events) {
      state = transition(serviceRequestMachine, state, event).to;
      switch (event) {
        case 'ESCALATE':
          data.escalatedAt = now;
          out.push({ type: 'ServiceRequestEscalated', payload: { serviceRequestId: row.id } });
          break;
        case 'ACKNOWLEDGE': {
          const staffId = by.staffId ?? null;
          data.acknowledgedAt = now;
          data.acknowledgedById = staffId;
          if (row.alertId !== null && staffId !== null) {
            await this.notifications.acknowledgeInTx(tx, row.restaurantId, row.alertId, staffId);
          }
          out.push({
            type: 'ServiceRequestAcknowledged',
            payload: { serviceRequestId: row.id, acknowledgedBy: staffId },
          });
          break;
        }
        case 'CANCEL':
        case 'RESOLVE':
          data.closedAt = now;
          data.closedById = by.staffId ?? null;
          data.closedByDeviceId = by.deviceId ?? null;
          if (row.alertId !== null) {
            await this.notifications.clear(tx, {
              restaurantId: row.restaurantId,
              ids: [row.alertId],
            });
          }
          out.push({
            type: 'ServiceRequestCancelled',
            payload: {
              serviceRequestId: row.id,
              resolution: event === 'CANCEL' ? 'CANCELLED' : 'RESOLVED',
            },
          });
          break;
      }
    }
    const updated = await tx.serviceRequest.update({
      where: { id: row.id },
      data: { ...data, state },
      include: WITH_TABLE,
    });
    await this.emit(tx, updated, isoDateOf(updated.businessDate), out);
    return updated;
  }

  private tableOf(device: AuthenticatedDevice): string {
    if (device.type !== 'TABLE_TABLET' || device.tableId === null) throw errors.notATablet();
    return device.tableId;
  }

  private async lock(
    tx: TransactionClient,
    restaurantId: string,
    requestId: string,
  ): Promise<RequestRow | null> {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM service_requests
      WHERE id = ${requestId}::uuid AND restaurant_id = ${restaurantId}::uuid
      FOR UPDATE`;
    if (locked === undefined) return null;
    return tx.serviceRequest.findUnique({ where: { id: locked.id }, include: WITH_TABLE });
  }

  private async lockByAlert(tx: TransactionClient, alertId: string): Promise<RequestRow | null> {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM service_requests WHERE alert_id = ${alertId}::uuid FOR UPDATE`;
    if (locked === undefined) return null;
    return tx.serviceRequest.findUnique({ where: { id: locked.id }, include: WITH_TABLE });
  }

  private async emit(
    tx: TransactionClient,
    row: RequestRow,
    businessDate: string,
    events: readonly EventInput[],
  ): Promise<void> {
    const occurredAt = this.clock.now().toISOString();
    for (const event of events) {
      await appendEvent(
        tx,
        {
          eventId: newId(),
          version: 1,
          occurredAt,
          restaurantId: row.restaurantId,
          businessDate,
          ...event,
        },
        {
          aggregate: { type: 'service_request', id: row.id },
          // The tablet at the guests' table hears what happened to its call (AUTH-009).
          audience: { tableIds: [row.tableSession.table.id] },
        },
      );
    }
  }

  private async viewOf(tx: TransactionClient, row: RequestRow): Promise<ServiceRequestView> {
    const [view] = await this.views(tx, [row]);
    if (view === undefined) throw new Error('A service request has no view');
    return view;
  }

  private async views(
    db: Pick<TransactionClient, 'staff'>,
    rows: readonly RequestRow[],
  ): Promise<ServiceRequestView[]> {
    const staffIds = [...new Set(rows.flatMap((row) => row.acknowledgedById ?? []))];
    const people =
      staffIds.length === 0
        ? []
        : await db.staff.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, displayName: true },
          });
    const names = new Map(people.map((person) => [person.id, person.displayName]));
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      state: row.state,
      source: row.source,
      tableId: row.tableSession.table.id,
      tableLabel: row.tableSession.table.label,
      tableSessionId: row.tableSessionId,
      createdAt: row.createdAt.toISOString(),
      escalatedAt: row.escalatedAt?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      acknowledgedById: row.acknowledgedById,
      acknowledgedByName:
        row.acknowledgedById === null ? null : (names.get(row.acknowledgedById) ?? null),
      closedAt: row.closedAt?.toISOString() ?? null,
    }));
  }
}
