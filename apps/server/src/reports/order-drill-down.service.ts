import { Injectable } from '@nestjs/common';
import type { OrderDrillDownResponse } from '@rp/contracts';
import { isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';

type StaffRef = OrderDrillDownResponse['createdBy'];
type DeviceRef = OrderDrillDownResponse['device'];

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function reasonOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('reason' in payload)) return null;
  const { reason } = payload;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Order-level drill-down (P1-13b, RPT-015): who created the order and on which device, who approved
 * it, each item's status times, its KOTs, every state change from the order history, every audited
 * action on the order, its items, its bill and its invoices, and who issued, printed, settled or
 * voided each invoice. A table's bill covers all its orders, so its invoices appear on each of
 * them.
 */
@Injectable()
export class OrderDrillDownService {
  constructor(private readonly prisma: PrismaService) {}

  async drillDown(restaurantId: string, orderId: string): Promise<OrderDrillDownResponse> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: {
        table: { select: { label: true } },
        items: { orderBy: { createdAt: 'asc' } },
        kots: { orderBy: { kotNumber: 'asc' }, include: { station: { select: { name: true } } } },
        events: { orderBy: { occurredAt: 'asc' } },
        approvals: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (order === null) throw new AppError(404, 'ORDER_NOT_FOUND', 'There is no such order.');

    const billedTogether =
      order.tableSessionId === null
        ? { orderId: order.id }
        : { OR: [{ orderId: order.id }, { tableSessionId: order.tableSessionId }] };
    const [bills, invoices] = await Promise.all([
      this.prisma.bill.findMany({
        where: { restaurantId, ...billedTogether },
        select: { id: true },
      }),
      this.prisma.invoice.findMany({
        where: { restaurantId, ...billedTogether },
        orderBy: [{ issuedAt: 'asc' }, { sequence: 'asc' }],
      }),
    ]);
    const itemIds = order.items.map((item) => item.id);
    const invoiceIds = invoices.map((invoice) => invoice.id);
    const entries = await this.prisma.auditLog.findMany({
      where: {
        restaurantId,
        OR: [
          { entityType: 'order', entityId: order.id },
          { entityType: 'order_item', entityId: { in: itemIds } },
          { entityType: 'bill', entityId: { in: bills.map((bill) => bill.id) } },
          { entityType: 'invoice', entityId: { in: invoiceIds } },
        ],
      },
      orderBy: { chainSeq: 'asc' },
    });

    const staffIds = new Set<string>();
    const deviceIds = new Set<string>();
    const note = (id: string | null, into: Set<string>) => {
      if (id !== null) into.add(id);
    };
    note(order.createdById, staffIds);
    note(order.deviceId, deviceIds);
    for (const item of order.items) {
      note(item.createdById, staffIds);
      note(item.approvedById, staffIds);
    }
    for (const approval of order.approvals) {
      note(approval.requestedById, staffIds);
      note(approval.approvedById, staffIds);
    }
    for (const event of order.events) {
      note(event.actorId, staffIds);
      note(event.deviceId, deviceIds);
    }
    for (const entry of entries) {
      note(entry.actorId, staffIds);
      note(entry.approverId, staffIds);
      note(entry.deviceId, deviceIds);
    }
    for (const invoice of invoices) note(invoice.issuedById, staffIds);
    const [staff, devices] = await Promise.all([
      this.prisma.staff.findMany({
        where: { restaurantId, id: { in: [...staffIds] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.device.findMany({
        where: { restaurantId, id: { in: [...deviceIds] } },
        select: { id: true, name: true, type: true },
      }),
    ]);
    const names = new Map(staff.map((person) => [person.id, person.displayName]));
    const deviceById = new Map(devices.map((device) => [device.id, device]));
    const person = (id: string | null): StaffRef => {
      if (id === null) return null;
      return { id, name: names.get(id) ?? 'Unknown' };
    };
    const device = (id: string | null): DeviceRef => {
      const found = id === null ? undefined : deviceById.get(id);
      return found === undefined ? null : { id: found.id, name: found.name, type: found.type };
    };
    const itemNames = new Map(order.items.map((item) => [item.id, item.name]));
    const firstEntry = (invoiceId: string, action: string) =>
      entries.find((entry) => entry.entityId === invoiceId && entry.action === action);

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      businessDate: isoDateOf(order.businessDate),
      orderType: order.orderType,
      source: order.source,
      status: order.status,
      tableLabel: order.table?.label ?? null,
      takeawayToken: order.takeawayToken,
      createdAt: order.createdAt.toISOString(),
      createdBy: person(order.createdById),
      device: device(order.deviceId),
      approvals: order.approvals.map((approval) => ({
        action: approval.action,
        status: approval.status,
        requestedBy: person(approval.requestedById),
        decidedBy: person(approval.approvedById),
        requestedAt: approval.createdAt.toISOString(),
        decidedAt: iso(approval.decidedAt),
        reason: approval.reason,
      })),
      items: order.items.map((item) => ({
        orderItemId: item.id,
        name: item.name,
        variantName: item.variantName,
        quantity: item.quantity,
        state: item.state,
        createdBy: person(item.createdById),
        approvedBy: person(item.approvedById),
        sentAt: iso(item.sentAt),
        preparingAt: iso(item.preparingAt),
        readyAt: iso(item.readyAt),
        pickedUpAt: iso(item.pickedUpAt),
        servedAt: iso(item.servedAt),
        endedAt: iso(item.endedAt),
        endReason: item.endReason,
      })),
      kots: order.kots.map((kot) => ({
        kotId: kot.id,
        kotNumber: kot.kotNumber,
        kind: kot.kind,
        station: kot.station.name,
        createdAt: kot.createdAt.toISOString(),
        printStatus: kot.printStatus,
        printedAt: iso(kot.printedAt),
      })),
      history: order.events.map((event) => ({
        at: event.occurredAt.toISOString(),
        event: event.type,
        orderItemId: event.orderItemId,
        itemName: event.orderItemId === null ? null : (itemNames.get(event.orderItemId) ?? null),
        fromState: event.fromState,
        toState: event.toState,
        by: person(event.actorId),
        device: device(event.deviceId),
        reason: reasonOf(event.payload),
      })),
      audit: entries.map((entry) => ({
        at: entry.occurredAt.toISOString(),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        by: person(entry.actorId),
        approvedBy: person(entry.approverId),
        device: device(entry.deviceId),
        reason: entry.reason,
      })),
      invoices: invoices.map((invoice) => {
        const printed = firstEntry(invoice.id, 'INVOICE_PRINTED');
        const settled = firstEntry(invoice.id, 'BILL_SETTLED');
        const voided = firstEntry(invoice.id, 'INVOICE_VOIDED');
        return {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          grandTotal: invoice.grandTotal,
          issuedAt: invoice.issuedAt.toISOString(),
          issuedBy: person(invoice.issuedById),
          printCount: invoice.printCount,
          printedBy: person(printed?.actorId ?? null),
          settledAt: iso(invoice.settledAt),
          settledBy: person(settled?.actorId ?? null),
          voidedAt: iso(invoice.voidedAt),
          voidedBy: person(voided?.actorId ?? null),
          voidApprovedBy: person(voided?.approverId ?? null),
          voidReason: invoice.voidReason,
        };
      }),
    };
  }
}
