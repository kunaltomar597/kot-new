import { Injectable } from '@nestjs/common';
import type { InvoiceView, PrintInvoiceResponse } from '@rp/contracts';
import { tableMachine, transition } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { ConsumedOverride, Principal } from '../auth/principal.js';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { paperWidthOf, renderBill } from '../printing/escpos.js';
import { PrinterStatusService } from '../printing/printer-status.service.js';
import { PrintFailure, PrinterTransport } from '../printing/printer-transport.js';
import { SettingsService } from '../settings/settings.service.js';
import { InvoicesService } from './invoices.service.js';

function invoiceNotFound(): AppError {
  return new AppError(404, 'INVOICE_NOT_FOUND', 'There is no such invoice.');
}

/**
 * What happens to an invoice after it is issued (P1-10b): printing it on the bill printer, where
 * every print after the first is marked DUPLICATE and audited (BILL-009, BILL-014), and voiding it
 * so the bill can be corrected and issued again with a new number (BILL-010, BILL-003).
 */
@Injectable()
export class InvoiceActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly invoices: InvoicesService,
    private readonly transport: PrinterTransport,
    private readonly printerStatus: PrinterStatusService,
  ) {}

  /**
   * Prints the invoice. The row is locked while it prints, so two tills pressing Print at once
   * cannot both print an original.
   */
  async print(
    principal: Principal,
    invoiceId: string,
    printerId: string | null,
  ): Promise<PrintInvoiceResponse> {
    const view = await this.invoices.view(principal.restaurantId, invoiceId);
    if (view.status === 'VOIDED') {
      throw new AppError(409, 'INVOICE_VOIDED', 'This invoice is voided. Print its replacement.');
    }
    const snapshot = await this.settings.snapshot(principal.restaurantId);
    const chosen = printerId ?? snapshot.get('bills.printerId');
    if (chosen === null) {
      throw new AppError(
        422,
        'NO_BILL_PRINTER',
        'No bill printer is set. Choose a printer, or set the bill printer in settings.',
      );
    }
    const printer = await this.prisma.printer.findFirst({
      where: { id: chosen, restaurantId: principal.restaurantId, archivedAt: null },
    });
    if (printer === null) {
      throw new AppError(422, 'PRINTER_NOT_FOUND', 'There is no such active printer.');
    }
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: principal.restaurantId },
      select: { timeZone: true },
    });

    const outcome = await this.prisma.transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
        const current = await tx.invoice.findUniqueOrThrow({
          where: { id: invoiceId },
          select: { printCount: true },
        });
        const duplicate = current.printCount > 0;
        const bytes = renderBill(view, {
          paperWidthMm: paperWidthOf(printer),
          duplicate,
          timeZone: restaurant.timeZone,
        });
        try {
          await this.transport.send(
            { connection: printer.connection, host: printer.host ?? '', port: printer.port },
            bytes,
          );
        } catch (error) {
          if (!(error instanceof PrintFailure)) throw error;
          return { duplicate, printCount: current.printCount, error: error.message };
        }
        const updated = await tx.invoice.update({
          where: { id: invoiceId },
          data: { printCount: { increment: 1 } },
          select: { printCount: true },
        });
        if (duplicate) {
          await this.audit.record(tx, {
            action: 'INVOICE_REPRINTED',
            entityType: 'invoice',
            entityId: invoiceId,
            actorId: principal.staffId,
            deviceId: principal.deviceId,
            restaurantId: principal.restaurantId,
            before: { printCount: current.printCount },
            after: { printCount: updated.printCount, printerId: printer.id },
            reason: null,
          });
          await appendEvent(
            tx,
            {
              eventId: newId(),
              type: 'BillPrinted',
              version: 1,
              occurredAt: new Date().toISOString(),
              restaurantId: principal.restaurantId,
              businessDate: await currentBusinessDate(tx, principal.restaurantId),
              payload: {
                invoiceId,
                invoiceNumber: view.invoiceNumber,
                grandTotal: view.grandTotal,
                duplicate: true,
              },
            },
            { aggregate: { type: 'invoice', id: invoiceId } },
          );
        }
        return { duplicate, printCount: updated.printCount, error: null };
      },
      // Long enough for a slow printer (the transport gives up after 5 s).
      { timeout: 20_000 },
    );
    if (outcome.error === null) await this.printerStatus.markOnline(printer.id);
    else await this.printerStatus.markOffline(printer.id, outcome.error);
    return {
      printed: outcome.error === null,
      error: outcome.error,
      duplicate: outcome.duplicate,
      printCount: outcome.printCount,
    };
  }

  /**
   * Voids the invoice (BILL-010): it keeps its number with status VOIDED (BILL-003), the bill opens
   * again for correction, and the table waits for the new bill. Audited with the approver.
   */
  async void(
    principal: Principal,
    invoiceId: string,
    reason: string,
    override: ConsumedOverride | undefined,
  ): Promise<InvoiceView> {
    await this.prisma.transaction(async (tx) => {
      const found = await tx.invoice.findFirst({
        where: { id: invoiceId, restaurantId: principal.restaurantId },
        select: { billId: true, tableSession: { select: { tableId: true, status: true } } },
      });
      if (found === null) throw invoiceNotFound();
      if (found.tableSession !== null) {
        await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${found.tableSession.tableId}::uuid FOR UPDATE`;
      }
      if (found.billId !== null) {
        await tx.$queryRaw`SELECT 1 AS locked FROM bills WHERE id = ${found.billId}::uuid FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT 1 AS locked FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (invoice.status === 'VOIDED') {
        throw new AppError(409, 'INVOICE_ALREADY_VOIDED', 'This invoice is already voided.');
      }
      const now = new Date();
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'VOIDED', voidedAt: now, voidReason: reason },
      });
      if (invoice.billId !== null) {
        await tx.bill.update({ where: { id: invoice.billId }, data: { status: 'OPEN' } });
      }
      await this.audit.record(tx, {
        action: 'INVOICE_VOIDED',
        entityType: 'invoice',
        entityId: invoiceId,
        actorId: principal.staffId,
        approverId: override?.approverId ?? null,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: {
          status: invoice.status,
          invoiceNumber: invoice.invoiceNumber,
          grandTotal: invoice.grandTotal,
        },
        after: { status: 'VOIDED' },
        reason,
      });

      // The table no longer has a valid bill: back to Occupied until the new one prints.
      const session = found.tableSession;
      if (session?.status === 'OPEN') {
        const table = await tx.diningTable.findUniqueOrThrow({ where: { id: session.tableId } });
        if (table.state === 'BILL_PRINTED') {
          const to = transition(tableMachine, table.state, 'ADD_ITEMS').to;
          await tx.diningTable.update({ where: { id: table.id }, data: { state: to } });
          await appendEvent(
            tx,
            {
              eventId: newId(),
              type: 'TableStateChanged',
              version: 1,
              occurredAt: now.toISOString(),
              restaurantId: principal.restaurantId,
              businessDate: await currentBusinessDate(tx, principal.restaurantId, now),
              payload: { tableId: table.id, state: to },
            },
            { aggregate: { type: 'invoice', id: invoiceId }, audience: { tableIds: [table.id] } },
          );
        }
      }
    });
    return this.invoices.view(principal.restaurantId, invoiceId);
  }
}
