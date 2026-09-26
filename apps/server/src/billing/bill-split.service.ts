import { Injectable } from '@nestjs/common';
import type { SplitBillRequest, SplitBillResponse } from '@rp/contracts';
import { splitBill, tableMachine, transition } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { SettingsService } from '../settings/settings.service.js';
import { describeItem } from './bill-calculation.js';
import type { BillContext } from './bills.service.js';
import { BillsService } from './bills.service.js';
import { InvoicesService, particularsOf } from './invoices.service.js';

export type ParsedSplit = ReturnType<typeof SplitBillRequest.parse>;

/** `shares[part][line]`: how much of each bill line each part takes. */
function sharesOf(context: BillContext, request: ParsedSplit): number[][] {
  const lines = context.calculated.result.lines;
  if (request.mode === 'EQUAL') {
    return Array.from({ length: request.parts }, () => lines.map(() => 1));
  }
  const indexOf = new Map(lines.map((line, index) => [line.id, index]));
  const shares = request.parts.map((part) => {
    const row = lines.map(() => 0);
    for (const entry of part) {
      const index = indexOf.get(entry.orderItemId);
      if (index === undefined) {
        throw new AppError(422, 'SPLIT_INVALID', 'An item in the split is not on this bill.', {
          orderItemId: entry.orderItemId,
        });
      }
      row[index] = (row[index] ?? 0) + entry.quantity;
    }
    return row;
  });
  const mismatched = lines.flatMap((line, index) => {
    const given = shares.reduce((total, row) => total + (row[index] ?? 0), 0);
    return given === line.quantity
      ? []
      : [{ orderItemId: line.id, quantity: line.quantity, given }];
  });
  if (mismatched.length > 0) {
    throw new AppError(
      422,
      'SPLIT_INCOMPLETE',
      'Give out every item on the bill exactly once across the parts.',
      { mismatched },
    );
  }
  return shares;
}

/**
 * Split bills (P1-10d, BILL-007): a bill is split by items or into equal parts, and each part is
 * issued as its own invoice with the next number of the series, all in one transaction. The parts
 * come from `@rp/domain` `splitBill`, so their lines, discounts, taxes per component, service
 * charge and round-off add up exactly to the whole bill.
 */
@Injectable()
export class BillSplitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly bills: BillsService,
    private readonly invoices: InvoicesService,
  ) {}

  async split(
    principal: Principal,
    billId: string,
    request: ParsedSplit,
  ): Promise<SplitBillResponse> {
    const invoiceIds = await this.prisma.transaction(async (tx) => {
      const context = await this.bills.lockedOpenBill(tx, principal.restaurantId, billId);
      const { bill, calculated } = context;
      const { result } = calculated;
      if (bill.editingInvoiceId !== null) {
        throw new AppError(
          409,
          'BILL_BEING_EDITED',
          'This bill is reopened to edit its printed invoice. Print it again instead of splitting.',
        );
      }
      const replaces = await tx.invoice.findFirst({
        where: { billId, status: 'VOIDED', replacedBy: { none: {} } },
        orderBy: [{ voidedAt: 'desc' }, { sequence: 'desc' }],
        select: { id: true },
      });
      await this.invoices.assertBillable(tx, context, replaces !== null);
      const shares = sharesOf(context, request);
      const parts = splitBill(result, shares);

      const [restaurant, snapshot] = await Promise.all([
        tx.restaurant.findUniqueOrThrow({ where: { id: principal.restaurantId } }),
        this.settings.snapshot(principal.restaurantId),
      ]);
      const particulars = particularsOf(restaurant, snapshot);
      const now = new Date();
      const businessDate = await currentBusinessDate(tx, principal.restaurantId, now);
      const itemsById = new Map(context.items.map((item) => [item.id, item]));
      const unitPriceOf = new Map(result.lines.map((line) => [line.id, line.unitPrice]));
      const realGroup = (key: string) => calculated.groupIdOf.get(key) ?? key;
      const sacOf = (groupId: string) => context.taxGroups.get(groupId)?.sacCode ?? null;

      const created: { id: string; invoiceNumber: string; grandTotal: number }[] = [];
      for (const [index, part] of parts.entries()) {
        const numbering = await this.invoices.nextNumber(
          tx,
          principal.restaurantId,
          request.seriesId,
          now,
          restaurant.timeZone,
        );
        const lines: {
          restaurantId: string;
          orderItemId: string | null;
          description: string;
          quantity: number;
          unitPrice: number;
          lineTotal: number;
          discount: number;
          taxableValue: number;
          taxGroupId: string;
          sacCode: string | null;
        }[] = part.lines.map((line) => {
          const item = itemsById.get(line.lineId);
          const taxGroupId = realGroup(line.taxGroupId);
          const description = item === undefined ? '' : describeItem(item);
          return {
            restaurantId: principal.restaurantId,
            orderItemId: line.lineId,
            // Equal parts carry every line at its full quantity, with this part's share of it.
            description:
              request.mode === 'EQUAL'
                ? `${description} (share ${String(index + 1)} of ${String(parts.length)})`
                : description,
            quantity: request.mode === 'EQUAL' ? (item?.quantity ?? 1) : line.share,
            unitPrice: unitPriceOf.get(line.lineId) ?? 0,
            lineTotal: line.grossAmount,
            discount: line.discount,
            taxableValue: line.taxableValue,
            taxGroupId,
            sacCode: sacOf(taxGroupId),
          };
        });
        const serviceChargeTax = part.taxLines.find((line) => line.source === 'SERVICE_CHARGE');
        if (part.serviceCharge > 0 && serviceChargeTax !== undefined) {
          const taxGroupId = realGroup(serviceChargeTax.taxGroupId);
          lines.push({
            restaurantId: principal.restaurantId,
            orderItemId: null,
            description: 'Service charge (voluntary)',
            quantity: 1,
            unitPrice: part.serviceCharge,
            lineTotal: part.serviceCharge,
            discount: 0,
            taxableValue: serviceChargeTax.taxableValue,
            taxGroupId,
            sacCode: sacOf(taxGroupId),
          });
        }
        const taxLines = part.taxLines.flatMap((line) =>
          line.components.map((component) => ({
            restaurantId: principal.restaurantId,
            taxGroupId: realGroup(line.taxGroupId),
            code: component.code,
            rateBp: component.rateBp,
            taxableValue: line.taxableValue,
            amount: component.amount,
          })),
        );
        const invoice = await tx.invoice.create({
          data: {
            id: newId(),
            restaurantId: principal.restaurantId,
            businessDate: dbDate(businessDate),
            invoiceDate: dbDate(numbering.invoiceDate),
            financialYear: numbering.financialYear,
            seriesId: numbering.seriesId,
            sequence: numbering.sequence,
            invoiceNumber: numbering.invoiceNumber,
            billId,
            tableSessionId: bill.tableSessionId,
            orderId: bill.orderId,
            particulars,
            priceMode: result.priceMode,
            subtotal: part.subtotal,
            discountTotal: part.discountTotal,
            serviceCharge: part.serviceCharge,
            taxTotal: part.taxTotal,
            roundOff: part.roundOff,
            grandTotal: part.grandTotal,
            customerName: bill.customerName,
            customerGstin: bill.customerGstin,
            customerPhone: bill.customerPhone,
            customerPhoneConsent: bill.customerPhoneConsent,
            issuedById: principal.staffId,
            issuedAt: now,
            printCount: 0,
            replacesInvoiceId: index === 0 ? (replaces?.id ?? null) : null,
            lines: { create: lines },
            taxLines: { create: taxLines },
          },
        });
        created.push({
          id: invoice.id,
          invoiceNumber: numbering.invoiceNumber,
          grandTotal: part.grandTotal,
        });
      }

      // Discounts keep the amount the whole bill gave; they belong to the bill, not one part.
      for (const discount of context.discounts) {
        await tx.discount.update({
          where: { id: discount.id },
          data: { amount: this.bills.discountAmount(context, discount.id) },
        });
      }
      await tx.bill.update({ where: { id: billId }, data: { status: 'INVOICED' } });

      const envelope = {
        version: 1 as const,
        occurredAt: now.toISOString(),
        restaurantId: principal.restaurantId,
        businessDate,
      };
      const audience = context.tableId !== null ? { tableIds: [context.tableId] } : undefined;
      if (context.tableId !== null) {
        const table = await tx.diningTable.findUniqueOrThrow({ where: { id: context.tableId } });
        if (table.state !== 'BILL_PRINTED') {
          const to = transition(tableMachine, table.state, 'PRINT_BILL').to;
          await tx.diningTable.update({ where: { id: table.id }, data: { state: to } });
          await appendEvent(
            tx,
            {
              ...envelope,
              eventId: newId(),
              type: 'TableStateChanged',
              payload: { tableId: table.id, state: to },
            },
            { aggregate: { type: 'bill', id: billId }, ...(audience && { audience }) },
          );
        }
      }
      for (const invoice of created) {
        await appendEvent(
          tx,
          {
            ...envelope,
            eventId: newId(),
            type: 'BillPrinted',
            payload: {
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              grandTotal: invoice.grandTotal,
              duplicate: false,
            },
          },
          { aggregate: { type: 'invoice', id: invoice.id }, ...(audience && { audience }) },
        );
      }
      await this.audit.record(tx, {
        action: 'BILL_SPLIT',
        entityType: 'bill',
        entityId: billId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { grandTotal: result.grandTotal },
        after: {
          mode: request.mode,
          invoices: created.map(({ invoiceNumber, grandTotal }) => ({ invoiceNumber, grandTotal })),
        },
        reason: null,
      });
      return created.map((invoice) => invoice.id);
    });
    return {
      invoices: await Promise.all(
        invoiceIds.map((id) => this.invoices.view(principal.restaurantId, id)),
      ),
    };
  }
}
