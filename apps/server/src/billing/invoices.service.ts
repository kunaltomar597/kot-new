import { Injectable } from '@nestjs/common';
import { type InvoiceParticulars, type InvoiceView } from '@rp/contracts';
import {
  calendarDateOf,
  financialYearOf,
  formatInvoiceNumber,
  maxSequenceFor,
  tableMachine,
  transition,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { allocateInvoiceSequence } from '../database/numbering.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import type { Invoice, InvoiceLine, Restaurant, TaxLine } from '../generated/prisma/client.js';
import { SettingsService, type SettingsSnapshot } from '../settings/settings.service.js';
import { describeItem } from './bill-calculation.js';
import { type BillContext, BillsService } from './bills.service.js';

/** Sequence key of a series that runs on across financial years (PROGRESS decision 17). */
export const CONTINUOUS_SEQUENCE = '0000-00';

/** The seller's particulars as they are now, kept on each invoice as issued (BILL-002). */
export function particularsOf(
  restaurant: Restaurant,
  snapshot: SettingsSnapshot,
): InvoiceParticulars {
  return {
    displayName: restaurant.displayName,
    legalName: restaurant.legalName,
    address: (restaurant.address ?? null) as InvoiceParticulars['address'],
    gstin: restaurant.gstin,
    fssaiNumber: restaurant.fssaiNumber,
    placeOfSupply: restaurant.stateCode,
    phone: restaurant.phone,
    headerLines: snapshot.get('bills.headerLines'),
    footerLines: snapshot.get('bills.footerLines'),
  };
}

type InvoiceRow = Invoice & {
  lines: InvoiceLine[];
  taxLines: TaxLine[];
  tableSession: { table: { label: string } } | null;
};

function toParticulars(value: unknown): InvoiceParticulars {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof InvoiceParticulars, unknown>
  >;
  const text = (field: unknown): string | null => (typeof field === 'string' ? field : null);
  const lines = (field: unknown): string[] =>
    Array.isArray(field) ? field.filter((line): line is string => typeof line === 'string') : [];
  return {
    displayName: text(stored.displayName) ?? '',
    legalName: text(stored.legalName),
    address: (stored.address ?? null) as InvoiceParticulars['address'],
    gstin: text(stored.gstin),
    fssaiNumber: text(stored.fssaiNumber),
    placeOfSupply: text(stored.placeOfSupply),
    phone: text(stored.phone),
    headerLines: lines(stored.headerLines),
    footerLines: lines(stored.footerLines),
  };
}

/**
 * GST invoices (P1-10a, BILL-002, BILL-003). Printing a bill issues its invoice in one
 * transaction: the next number of the series (a row-locked counter, so numbers are consecutive
 * and a rolled-back issue gives its number back), the seller's particulars as they are now, the
 * lines and the tax lines per component, the final discount amounts, the table moving to Bill
 * printed, the audit entry and `BillPrinted`.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly bills: BillsService,
  ) {}

  async issue(principal: Principal, billId: string, seriesId: string | null): Promise<InvoiceView> {
    const invoiceId = await this.prisma.transaction(async (tx) => {
      const context = await this.bills.lockedOpenBill(tx, principal.restaurantId, billId);
      const { bill, calculated } = context;
      const { result } = calculated;
      // A voided invoice of this bill not yet replaced: the new one replaces it (BILL-010).
      const replaces = await tx.invoice.findFirst({
        where: { billId, status: 'VOIDED', replacedBy: { none: {} } },
        orderBy: [{ voidedAt: 'desc' }, { sequence: 'desc' }],
        select: { id: true },
      });
      await this.assertBillable(tx, context, replaces !== null);

      // A printed invoice reopened for editing is updated in place, keeping its number (BILL-010).
      const editing =
        bill.editingInvoiceId === null
          ? null
          : await tx.invoice.findUniqueOrThrow({ where: { id: bill.editingInvoiceId } });
      const [restaurant, snapshot] = await Promise.all([
        tx.restaurant.findUniqueOrThrow({ where: { id: principal.restaurantId } }),
        this.settings.snapshot(principal.restaurantId),
      ]);
      const now = new Date();
      const target =
        editing === null
          ? {
              kind: 'NEW' as const,
              numbering: await this.nextNumber(
                tx,
                principal.restaurantId,
                seriesId,
                now,
                restaurant.timeZone,
              ),
            }
          : { kind: 'EDIT' as const, invoice: editing };
      const invoiceNumber =
        target.kind === 'NEW' ? target.numbering.invoiceNumber : target.invoice.invoiceNumber;
      const businessDate = await currentBusinessDate(tx, principal.restaurantId, now);
      const version = editing === null ? 1 : editing.version + 1;

      const particulars = particularsOf(restaurant, snapshot);
      const itemsById = new Map(context.items.map((item) => [item.id, item]));
      const realGroup = (key: string) => calculated.groupIdOf.get(key) ?? key;
      const sacOf = (groupId: string) => context.taxGroups.get(groupId)?.sacCode ?? null;

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
        version: number;
      }[] = result.lines.map((line) => {
        const item = itemsById.get(line.id);
        const taxGroupId = realGroup(line.taxGroupId);
        return {
          restaurantId: principal.restaurantId,
          orderItemId: line.id,
          description: item === undefined ? '' : describeItem(item),
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.grossAmount,
          discount: line.itemDiscount + line.billDiscountShare,
          taxableValue: line.taxableValue,
          taxGroupId,
          sacCode: sacOf(taxGroupId),
          version,
        };
      });
      const serviceChargeTax = result.taxLines.find((line) => line.source === 'SERVICE_CHARGE');
      if (result.serviceCharge > 0 && serviceChargeTax !== undefined) {
        const taxGroupId = realGroup(serviceChargeTax.taxGroupId);
        lines.push({
          restaurantId: principal.restaurantId,
          orderItemId: null,
          description: 'Service charge (voluntary)',
          quantity: 1,
          unitPrice: result.serviceCharge,
          lineTotal: result.serviceCharge,
          discount: 0,
          taxableValue: serviceChargeTax.taxableValue,
          taxGroupId,
          sacCode: sacOf(taxGroupId),
          version,
        });
      }
      const taxLines = result.taxLines.flatMap((line) =>
        line.components.map((component) => ({
          restaurantId: principal.restaurantId,
          taxGroupId: realGroup(line.taxGroupId),
          code: component.code,
          rateBp: component.rateBp,
          taxableValue: line.taxableValue,
          amount: component.amount,
          version,
        })),
      );
      const amounts = {
        priceMode: result.priceMode,
        subtotal: result.subtotal,
        discountTotal: result.discountTotal,
        serviceCharge: result.serviceCharge,
        taxTotal: result.taxTotal,
        roundOff: result.roundOff,
        grandTotal: result.grandTotal,
        customerName: bill.customerName,
        customerGstin: bill.customerGstin,
        customerPhone: bill.customerPhone,
        customerPhoneConsent: bill.customerPhoneConsent,
      };

      const invoice =
        target.kind === 'NEW'
          ? await tx.invoice.create({
              data: {
                id: newId(),
                restaurantId: principal.restaurantId,
                businessDate: dbDate(businessDate),
                invoiceDate: dbDate(target.numbering.invoiceDate),
                financialYear: target.numbering.financialYear,
                seriesId: target.numbering.seriesId,
                sequence: target.numbering.sequence,
                invoiceNumber,
                billId,
                tableSessionId: bill.tableSessionId,
                orderId: bill.orderId,
                particulars,
                ...amounts,
                issuedById: principal.staffId,
                issuedAt: now,
                // Printing is its own step (`print`); the first successful print is the original.
                printCount: 0,
                replacesInvoiceId: replaces?.id ?? null,
                lines: { create: lines },
                taxLines: { create: taxLines },
              },
            })
          : // The edited invoice keeps its number, date and particulars as first issued; its new
            // lines are the next version, and its next print is an original again.
            await tx.invoice.update({
              where: { id: target.invoice.id },
              data: {
                ...amounts,
                version,
                printCount: 0,
                lines: { create: lines },
                taxLines: { create: taxLines },
              },
            });
      for (const discount of context.discounts) {
        await tx.discount.update({
          where: { id: discount.id },
          data: { invoiceId: invoice.id, amount: this.bills.discountAmount(context, discount.id) },
        });
      }
      await tx.bill.update({
        where: { id: billId },
        data: {
          status: 'INVOICED',
          editingInvoiceId: null,
          editReason: null,
          editRequestedById: null,
          editApprovedById: null,
        },
      });

      const envelope = {
        version: 1 as const,
        occurredAt: now.toISOString(),
        restaurantId: principal.restaurantId,
        businessDate,
      };
      const options = {
        aggregate: { type: 'invoice', id: invoice.id },
        ...(context.tableId !== null && { audience: { tableIds: [context.tableId] } }),
      };
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
            options,
          );
        }
      }
      await appendEvent(
        tx,
        {
          ...envelope,
          eventId: newId(),
          type: 'BillPrinted',
          payload: {
            invoiceId: invoice.id,
            invoiceNumber,
            grandTotal: result.grandTotal,
            duplicate: false,
          },
        },
        options,
      );
      const totals = {
        subtotal: result.subtotal,
        discountTotal: result.discountTotal,
        serviceCharge: result.serviceCharge,
        taxTotal: result.taxTotal,
        roundOff: result.roundOff,
        grandTotal: result.grandTotal,
      };
      if (editing !== null) {
        // BILL-010: who asked, who approved, why, and the values before and after.
        await this.audit.record(tx, {
          action: 'INVOICE_EDITED',
          entityType: 'invoice',
          entityId: invoice.id,
          actorId: principal.staffId,
          approverId: bill.editApprovedById,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          before: {
            version: editing.version,
            subtotal: editing.subtotal,
            discountTotal: editing.discountTotal,
            serviceCharge: editing.serviceCharge,
            taxTotal: editing.taxTotal,
            roundOff: editing.roundOff,
            grandTotal: editing.grandTotal,
          },
          after: { version, ...totals, lines: lines.length },
          reason: bill.editReason,
        });
        return invoice.id;
      }
      await this.audit.record(tx, {
        action: 'INVOICE_ISSUED',
        entityType: 'invoice',
        entityId: invoice.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: null,
        after: {
          invoiceNumber,
          billId,
          replacesInvoiceId: replaces?.id ?? null,
          subtotal: result.subtotal,
          discountTotal: result.discountTotal,
          serviceCharge: result.serviceCharge,
          taxTotal: result.taxTotal,
          roundOff: result.roundOff,
          grandTotal: result.grandTotal,
        },
        reason: null,
      });
      return invoice.id;
    });
    return this.view(principal.restaurantId, invoiceId);
  }

  async view(restaurantId: string, invoiceId: string): Promise<InvoiceView> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, restaurantId },
      include: {
        tableSession: { select: { table: { select: { label: true } } } },
      },
    });
    if (invoice === null) {
      throw new AppError(404, 'INVOICE_NOT_FOUND', 'There is no such invoice.');
    }
    // Only the current version's lines: earlier versions stay for the audit trail.
    const [lines, taxLines] = await Promise.all([
      this.prisma.invoiceLine.findMany({
        where: { invoiceId, version: invoice.version },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.taxLine.findMany({
        where: { invoiceId, version: invoice.version },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return this.toView({ ...invoice, lines, taxLines });
  }

  private toView(invoice: InvoiceRow): InvoiceView {
    return {
      id: invoice.id,
      billId: invoice.billId,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      invoiceDate: isoDateOf(invoice.invoiceDate),
      financialYear: invoice.financialYear,
      businessDate: isoDateOf(invoice.businessDate),
      issuedAt: invoice.issuedAt.toISOString(),
      issuedById: invoice.issuedById,
      tableLabel: invoice.tableSession?.table.label ?? null,
      particulars: toParticulars(invoice.particulars),
      customer: {
        name: invoice.customerName,
        phone: invoice.customerPhone,
        phoneConsent: invoice.customerPhoneConsent,
        gstin: invoice.customerGstin,
      },
      priceMode: invoice.priceMode,
      lines: invoice.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        discount: line.discount,
        taxableValue: line.taxableValue,
        sacCode: line.sacCode,
      })),
      taxLines: invoice.taxLines.map((line) => ({
        taxGroupId: line.taxGroupId,
        code: line.code,
        rateBp: line.rateBp,
        taxableValue: line.taxableValue,
        amount: line.amount,
      })),
      subtotal: invoice.subtotal,
      discountTotal: invoice.discountTotal,
      serviceCharge: invoice.serviceCharge,
      taxTotal: invoice.taxTotal,
      roundOff: invoice.roundOff,
      grandTotal: invoice.grandTotal,
      printCount: invoice.printCount,
      version: invoice.version,
      voidedAt: invoice.voidedAt?.toISOString() ?? null,
      voidReason: invoice.voidReason,
      replacesInvoiceId: invoice.replacesInvoiceId,
    };
  }

  /**
   * Refuses to bill a closed session (unless replacing a voided invoice), items still awaiting
   * approval, or an empty bill.
   */
  async assertBillable(
    tx: TransactionClient,
    context: BillContext,
    replacing: boolean,
  ): Promise<void> {
    const { bill } = context;
    if (bill.tableSessionId !== null && !replacing) {
      const session = await tx.tableSession.findUniqueOrThrow({
        where: { id: bill.tableSessionId },
        select: { status: true },
      });
      if (session.status !== 'OPEN') {
        throw new AppError(409, 'SESSION_CLOSED', 'This table session is already closed.');
      }
    }
    if (context.awaitingApproval > 0) {
      throw new AppError(
        409,
        'ITEMS_AWAITING_APPROVAL',
        `${String(context.awaitingApproval)} items are waiting for approval. Approve or reject them first.`,
        { awaitingApproval: context.awaitingApproval },
      );
    }
    if (context.calculated.result.lines.length === 0) {
      throw new AppError(409, 'NOTHING_TO_BILL', 'There is nothing on this bill yet.');
    }
  }

  /** The next number of the series (BILL-003), with the invoice date and financial year. */
  async nextNumber(
    tx: TransactionClient,
    restaurantId: string,
    seriesId: string | null,
    now: Date,
    timeZone: string,
  ) {
    const series = await this.series(tx, restaurantId, seriesId);
    const invoiceDate = calendarDateOf(now, timeZone);
    const financialYear = financialYearOf(invoiceDate);
    const config = {
      prefix: series.prefix,
      includeFinancialYear: series.includeFinancialYear,
      separator: series.separator === '-' ? ('-' as const) : ('/' as const),
      sequencePadding: series.sequencePadding,
    };
    const sequence = await allocateInvoiceSequence(tx, {
      restaurantId,
      seriesId: series.id,
      financialYear: config.includeFinancialYear ? financialYear.label : CONTINUOUS_SEQUENCE,
    });
    if (sequence > maxSequenceFor(config)) {
      throw new AppError(
        422,
        'SERIES_FULL',
        `Series ${series.name} has used every number it can print. Add a new series.`,
      );
    }
    return {
      seriesId: series.id,
      sequence,
      invoiceDate,
      financialYear: financialYear.label,
      invoiceNumber: formatInvoiceNumber(config, financialYear, sequence),
    };
  }

  private async series(tx: TransactionClient, restaurantId: string, seriesId: string | null) {
    const series = await tx.invoiceSeries.findFirst({
      where:
        seriesId === null
          ? { restaurantId, isDefault: true, archivedAt: null }
          : { id: seriesId, restaurantId, archivedAt: null },
    });
    if (series === null) {
      throw new AppError(
        422,
        'SERIES_NOT_FOUND',
        seriesId === null
          ? 'There is no default invoice series. Set one up first.'
          : 'There is no such active invoice series.',
      );
    }
    return series;
  }
}
