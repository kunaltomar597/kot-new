import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { InvoicePaymentsView, RecordPaymentsRequest } from '@rp/contracts';
import { applyPayments, canonicalJson, tableMachine, transition } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { SettingsService } from '../settings/settings.service.js';
import { ShiftsService } from './shifts.service.js';

export type ParsedPayments = ReturnType<typeof RecordPaymentsRequest.parse>;

const IDEMPOTENCY_SCOPE = 'payments.record';
const IDEMPOTENCY_DAYS = 7;

type Client = PrismaService | TransactionClient;

function invoiceNotFound(): AppError {
  return new AppError(404, 'INVOICE_NOT_FOUND', 'There is no such invoice.');
}

/**
 * Payments (P1-11a, BILL-008). Payments are recorded by hand against an issued invoice, split
 * across modes and in as many steps as needed, never beyond the total (`@rp/domain`
 * `applyPayments`). Cash goes into the cashier's open shift. When the payments equal the total the
 * invoice is SETTLED (`BillSettled`), and when the last bill of a table is settled the session
 * closes and the table is free again (TBL-004). A retried request with the same key records
 * nothing twice (ORD-013's rule, applied to money).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly shifts: ShiftsService,
  ) {}

  async record(
    principal: Principal,
    invoiceId: string,
    request: ParsedPayments,
  ): Promise<InvoicePaymentsView> {
    const requestHash = createHash('sha256')
      .update(canonicalJson({ invoiceId, payments: request.payments }))
      .digest('hex');
    const otherModes = (await this.settings.snapshot(principal.restaurantId)).get(
      'payments.otherModes',
    );
    for (const payment of request.payments) {
      if (payment.otherModeName !== null && !otherModes.includes(payment.otherModeName)) {
        throw new AppError(
          422,
          'UNKNOWN_PAYMENT_MODE',
          `"${payment.otherModeName}" is not one of this restaurant's payment modes.`,
          { modes: otherModes },
        );
      }
    }

    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${request.idempotencyKey}, 0))`;
      const previous = await tx.idempotencyRecord.findUnique({
        where: {
          restaurantId_scope_key: {
            restaurantId: principal.restaurantId,
            scope: IDEMPOTENCY_SCOPE,
            key: request.idempotencyKey,
          },
        },
      });
      if (previous !== null) {
        if (previous.requestHash !== requestHash) {
          throw new AppError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'This key was used for different payments. Use a new key for new payments.',
          );
        }
        return this.view(tx, principal.restaurantId, invoiceId);
      }

      await tx.$queryRaw`SELECT 1 AS locked FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, restaurantId: principal.restaurantId },
      });
      if (invoice === null) throw invoiceNotFound();
      if (invoice.status === 'VOIDED') {
        throw new AppError(
          409,
          'INVOICE_VOIDED',
          'This invoice is voided. Take payment on its replacement.',
        );
      }
      if (invoice.status === 'SETTLED') {
        throw new AppError(409, 'INVOICE_SETTLED', 'This bill is already paid.');
      }
      const alreadyPaid = await this.paidOf(tx, invoiceId);
      const outcome = applyPayments(invoice.grandTotal, alreadyPaid, request.payments);
      if (request.payments.length === 0 && !outcome.settled) {
        throw new AppError(422, 'NO_PAYMENTS', 'Record at least one payment.');
      }
      const shift = await this.shifts.openShiftOf(tx, principal);
      if (shift === null && request.payments.some((payment) => payment.mode === 'CASH')) {
        throw new AppError(
          409,
          'NO_OPEN_SHIFT',
          'Open a shift before taking cash, so the drawer can be counted.',
        );
      }

      const now = new Date();
      const businessDate = await currentBusinessDate(tx, principal.restaurantId, now);
      for (const [index, payment] of outcome.payments.entries()) {
        const input = request.payments[index];
        await tx.payment.create({
          data: {
            id: newId(),
            restaurantId: principal.restaurantId,
            businessDate: dbDate(businessDate),
            invoiceId,
            shiftId: shift?.id ?? null,
            mode: payment.mode,
            modeLabel: input?.otherModeName ?? null,
            amount: payment.amount,
            tendered: payment.tendered,
            change: payment.change,
            reference: input?.reference ?? null,
            receivedById: principal.staffId,
          },
        });
      }
      await this.audit.record(tx, {
        action: outcome.settled ? 'BILL_SETTLED' : 'PAYMENT_RECORDED',
        entityType: 'invoice',
        entityId: invoiceId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { paid: alreadyPaid, status: invoice.status },
        after: {
          payments: outcome.payments,
          paid: outcome.paid,
          remaining: outcome.remaining,
          status: outcome.settled ? 'SETTLED' : 'ISSUED',
        },
        reason: null,
      });

      let tableClosed = false;
      if (outcome.settled) {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { status: 'SETTLED', settledAt: now },
        });
        const envelope = {
          version: 1 as const,
          occurredAt: now.toISOString(),
          restaurantId: principal.restaurantId,
          businessDate,
        };
        await appendEvent(
          tx,
          {
            ...envelope,
            eventId: newId(),
            type: 'BillSettled',
            payload: { invoiceId, grandTotal: invoice.grandTotal },
          },
          { aggregate: { type: 'invoice', id: invoiceId } },
        );
        tableClosed = await this.closeTableIfPaid(tx, principal, invoice.billId, envelope);
      }

      await tx.idempotencyRecord.create({
        data: {
          restaurantId: principal.restaurantId,
          scope: IDEMPOTENCY_SCOPE,
          key: request.idempotencyKey,
          requestHash,
          statusCode: 200,
          response: { invoiceId },
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_DAYS * 86_400_000),
        },
      });
      return { ...(await this.view(tx, principal.restaurantId, invoiceId)), tableClosed };
    });
  }

  paymentsOf(restaurantId: string, invoiceId: string): Promise<InvoicePaymentsView> {
    return this.view(this.prisma, restaurantId, invoiceId);
  }

  async view(
    client: Client,
    restaurantId: string,
    invoiceId: string,
  ): Promise<InvoicePaymentsView> {
    const invoice = await client.invoice.findFirst({
      where: { id: invoiceId, restaurantId },
      include: {
        payments: { where: { status: 'CAPTURED' }, orderBy: { createdAt: 'asc' } },
        tableSession: { select: { status: true } },
      },
    });
    if (invoice === null) throw invoiceNotFound();
    const paid = invoice.payments.reduce((total, payment) => total + payment.amount, 0);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      grandTotal: invoice.grandTotal,
      paid,
      remaining: invoice.grandTotal - paid,
      payments: invoice.payments.map((payment) => ({
        id: payment.id,
        mode: payment.mode,
        modeLabel: payment.modeLabel,
        amount: payment.amount,
        tendered: payment.tendered,
        change: payment.change,
        reference: payment.reference,
        receivedById: payment.receivedById,
        shiftId: payment.shiftId,
        createdAt: payment.createdAt.toISOString(),
      })),
      tableClosed: invoice.tableSession?.status === 'CLOSED',
    };
  }

  private async paidOf(client: Client, invoiceId: string): Promise<number> {
    const paid = await client.payment.aggregate({
      where: { invoiceId, status: 'CAPTURED' },
      _sum: { amount: true },
    });
    return paid._sum.amount ?? 0;
  }

  /**
   * TBL-004: a table whose every bill is paid, with nothing ordered since printing, is free
   * again and its session closes.
   */
  private async closeTableIfPaid(
    tx: TransactionClient,
    principal: Principal,
    billId: string | null,
    envelope: { version: 1; occurredAt: string; restaurantId: string; businessDate: string },
  ): Promise<boolean> {
    if (billId === null) return false;
    const bill = await tx.bill.findUniqueOrThrow({
      where: { id: billId },
      select: { status: true, tableSession: { select: { id: true, tableId: true, status: true } } },
    });
    const session = bill.tableSession;
    if (session?.status !== 'OPEN' || bill.status !== 'INVOICED') return false;
    const unpaid = await tx.invoice.count({ where: { billId, status: 'ISSUED' } });
    if (unpaid > 0) return false;
    await tx.$queryRaw`SELECT 1 AS locked FROM tables WHERE id = ${session.tableId}::uuid FOR UPDATE`;
    const table = await tx.diningTable.findUniqueOrThrow({ where: { id: session.tableId } });
    // Items ordered after the bill was printed keep the table open for another bill.
    if (table.state !== 'BILL_PRINTED') return false;
    const to = transition(tableMachine, table.state, 'SETTLE_AND_CLOSE').to;
    await tx.tableSession.update({
      where: { id: session.id },
      data: { status: 'CLOSED', closedAt: new Date(envelope.occurredAt) },
    });
    await tx.diningTable.update({ where: { id: table.id }, data: { state: to } });
    const options = {
      aggregate: { type: 'table_session', id: session.id },
      audience: { tableIds: [table.id] },
    };
    await appendEvent(
      tx,
      {
        ...envelope,
        eventId: newId(),
        type: 'TableClosed',
        payload: { tableId: table.id, tableSessionId: session.id },
      },
      options,
    );
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
    await this.audit.record(tx, {
      action: 'TABLE_SESSION_CLOSED',
      entityType: 'table_session',
      entityId: session.id,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: { status: 'OPEN', state: table.state },
      after: { status: 'CLOSED', state: to },
      reason: 'Bill settled',
    });
    return true;
  }
}
