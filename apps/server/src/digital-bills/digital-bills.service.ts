import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { DigitalBillEntry, InvoiceDigitalBillsResponse } from '@rp/contracts';
import type { DigitalBillRequest } from '@rp/contracts/control-plane';
import { indianMobile, maskPhone, nextDigitalBillAttempt } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { invoiceView } from '../billing/invoices.service.js';
import { ControlPlaneError } from '../cloud/control-plane-client.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { EventBus } from '../events/event-bus.js';
import type { DigitalBill } from '../generated/prisma/client.js';
import { billTextLines } from '../printing/escpos.js';
import { SettingsService } from '../settings/settings.service.js';

export const DIGITAL_BILL_OPTIONS = Symbol('DIGITAL_BILL_OPTIONS');

export interface DigitalBillOptions {
  /** How often to look for bills to send; 0 never looks by itself (tests call `runDue`). */
  readonly checkEveryMs: number;
  readonly now: () => Date;
}

export const DEFAULT_DIGITAL_BILL_OPTIONS: DigitalBillOptions = {
  checkEveryMs: 30_000,
  now: () => new Date(),
};

/** Bills sent in one run; the rest wait for the next. */
const BATCH = 20;

const errors = {
  notFound: () => new AppError(404, 'INVOICE_NOT_FOUND', 'There is no such invoice.'),
  off: () =>
    new AppError(
      409,
      'DIGITAL_BILLS_OFF',
      'Digital bills are switched off. A manager can turn them on in Settings, under Bills.',
    ),
  voided: () => new AppError(409, 'INVOICE_VOIDED', 'A voided invoice is not sent.'),
  noConsent: () =>
    new AppError(
      422,
      'NO_DIGITAL_BILL_CONSENT',
      'The bill has no mobile number given with the diner’s consent. Add it to the bill’s customer details first.',
    ),
};

function plainError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Digital bills on the restaurant PC (BILL-012, BILL-011, P7-09b):
 *
 * - a settled bill whose diner gave a mobile number with consent is queued by itself when the
 *   restaurant has turned digital bills on (`bills.digitalBillChannel`); the cashier can send it
 *   again;
 * - the queue is sent through the vendor's Control Plane, which holds the provider's account; it
 *   waits while the internet is down and is tried again with back-off for up to a day;
 * - the whole number is kept only until the bill is sent or given up, then only its last four
 *   digits; every send is audited without the number.
 */
@Injectable()
export class DigitalBillsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DigitalBillsService.name);
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<number> | undefined;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly heartbeat: HeartbeatService,
    private readonly bus: EventBus,
    @Inject(DIGITAL_BILL_OPTIONS) private readonly options: DigitalBillOptions,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe({
      name: 'digital-bills.settled',
      types: ['BillSettled'],
      handle: async (event, context) => {
        if (event.type !== 'BillSettled') return;
        if (await this.queueSettled(context.tx, event.restaurantId, event.payload.invoiceId)) {
          this.soon();
        }
      },
    });
  }

  onApplicationBootstrap(): void {
    if (this.options.checkEveryMs > 0) this.schedule(this.options.checkEveryMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  /** After something was queued: send it now rather than at the next look. */
  private soon(): void {
    if (this.options.checkEveryMs > 0) this.schedule(1_000);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runDue()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Sending digital bills failed');
        })
        .finally(() => {
          this.schedule(this.options.checkEveryMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** The invoice's consented mobile number, as +91 and ten digits, or undefined. */
  private static consentedMobile(invoice: {
    readonly customerPhone: string | null;
    readonly customerPhoneConsent: boolean;
  }): string | undefined {
    if (!invoice.customerPhoneConsent || invoice.customerPhone === null) return undefined;
    return indianMobile(invoice.customerPhone);
  }

  /** On settling (`BillSettled`): queues the bill once, when it may be sent. */
  async queueSettled(
    tx: TransactionClient,
    restaurantId: string,
    invoiceId: string,
  ): Promise<boolean> {
    const channel = (await this.settings.snapshot(restaurantId)).get('bills.digitalBillChannel');
    if (channel === 'OFF') return false;
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, restaurantId },
      select: { customerPhone: true, customerPhoneConsent: true, businessDate: true, status: true },
    });
    if (invoice === null || invoice.status === 'VOIDED') return false;
    const phone = DigitalBillsService.consentedMobile(invoice);
    if (phone === undefined) return false;
    if ((await tx.digitalBill.count({ where: { invoiceId, requestedById: null } })) > 0) {
      return false;
    }
    await this.enqueue(tx, {
      restaurantId,
      invoiceId,
      businessDate: invoice.businessDate,
      channel,
      phone,
      requestedById: null,
      deviceId: null,
    });
    return true;
  }

  private async enqueue(
    tx: TransactionClient,
    bill: {
      readonly restaurantId: string;
      readonly invoiceId: string;
      readonly businessDate: Date;
      readonly channel: 'WHATSAPP' | 'SMS';
      readonly phone: string;
      readonly requestedById: string | null;
      readonly deviceId: string | null;
    },
  ): Promise<DigitalBill> {
    const now = this.options.now();
    const row = await tx.digitalBill.create({
      data: {
        restaurantId: bill.restaurantId,
        invoiceId: bill.invoiceId,
        businessDate: bill.businessDate,
        channel: bill.channel,
        phone: bill.phone,
        phoneMasked: maskPhone(bill.phone),
        status: 'QUEUED',
        nextAttemptAt: now,
        requestedById: bill.requestedById,
      },
    });
    // AUD-001: the bill leaves the restaurant (BILL-012). The number is not in the audit log.
    await this.audit.record(tx, {
      action: 'DIGITAL_BILL_QUEUED',
      entityType: 'invoice',
      entityId: bill.invoiceId,
      actorId: bill.requestedById,
      deviceId: bill.deviceId,
      restaurantId: bill.restaurantId,
      after: { digitalBillId: row.id, channel: bill.channel, phone: row.phoneMasked },
      reason: bill.requestedById === null ? 'Sent on settling, with the diner’s consent' : null,
    });
    return row;
  }

  private entry(
    bill: DigitalBill & { readonly requestedBy: { readonly displayName: string } | null },
  ): DigitalBillEntry {
    return {
      id: bill.id,
      invoiceId: bill.invoiceId,
      channel: bill.channel === 'SMS' ? 'SMS' : 'WHATSAPP',
      phone: bill.phoneMasked,
      status: bill.status,
      attempts: bill.attempts,
      nextAttemptAt: bill.status === 'QUEUED' ? (bill.nextAttemptAt?.toISOString() ?? null) : null,
      lastError: bill.lastError,
      link: bill.link,
      expiresAt: bill.expiresAt?.toISOString() ?? null,
      requestedBy: bill.requestedBy?.displayName ?? null,
      createdAt: bill.createdAt.toISOString(),
      sentAt: bill.sentAt?.toISOString() ?? null,
    };
  }

  /** The invoice's digital bills, newest first, and whether one may be sent. */
  async list(restaurantId: string, invoiceId: string): Promise<InvoiceDigitalBillsResponse> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, restaurantId },
      select: { customerPhone: true, customerPhoneConsent: true },
    });
    if (invoice === null) throw errors.notFound();
    const [channel, bills] = await Promise.all([
      this.settings
        .snapshot(restaurantId)
        .then((settings) => settings.get('bills.digitalBillChannel')),
      this.prisma.digitalBill.findMany({
        where: { invoiceId },
        include: { requestedBy: { select: { displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const phone = DigitalBillsService.consentedMobile(invoice);
    return {
      channel,
      phone: phone === undefined ? null : maskPhone(phone),
      bills: bills.map((bill) => this.entry(bill)),
    };
  }

  /** The cashier sends the bill (again). */
  async send(principal: Principal, invoiceId: string): Promise<DigitalBillEntry> {
    const channel = (await this.settings.snapshot(principal.restaurantId)).get(
      'bills.digitalBillChannel',
    );
    if (channel === 'OFF') throw errors.off();
    const row = await this.prisma.transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, restaurantId: principal.restaurantId },
        select: {
          customerPhone: true,
          customerPhoneConsent: true,
          businessDate: true,
          status: true,
        },
      });
      if (invoice === null) throw errors.notFound();
      if (invoice.status === 'VOIDED') throw errors.voided();
      const phone = DigitalBillsService.consentedMobile(invoice);
      if (phone === undefined) throw errors.noConsent();
      const queued = await this.enqueue(tx, {
        restaurantId: principal.restaurantId,
        invoiceId,
        businessDate: invoice.businessDate,
        channel,
        phone,
        requestedById: principal.staffId,
        deviceId: principal.deviceId,
      });
      return tx.digitalBill.findUniqueOrThrow({
        where: { id: queued.id },
        include: { requestedBy: { select: { displayName: true } } },
      });
    });
    this.soon();
    return this.entry(row);
  }

  /** Sends what is due, one bill at a time; one run at a time. Returns how many were tried. */
  runDue(): Promise<number> {
    const run = (this.current ?? Promise.resolve(0)).catch(() => 0).then(() => this.sendDue());
    this.current = run;
    return run;
  }

  private async sendDue(): Promise<number> {
    const now = this.options.now();
    const due = await this.prisma.digitalBill.findMany({
      where: { status: 'QUEUED', nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: BATCH,
    });
    if (due.length === 0) return 0;
    const connection = await this.heartbeat.connection();
    for (const bill of due) {
      if ('unavailable' in connection) {
        await this.failed(
          bill,
          connection.unavailable === 'NOT_CONFIGURED'
            ? 'This PC has no connection to the vendor set up.'
            : 'This PC is not activated with the vendor yet.',
          true,
        );
        continue;
      }
      try {
        const view = await connection.client.sendDigitalBill(
          connection.installationId,
          await this.request(bill),
        );
        if (view.status === 'SENT') {
          await this.prisma.digitalBill.update({
            where: { id: bill.id },
            data: {
              status: 'SENT',
              attempts: { increment: 1 },
              phone: null,
              link: view.link,
              expiresAt: new Date(view.expiresAt),
              sentAt: view.sentAt === null ? this.options.now() : new Date(view.sentAt),
              lastError: null,
              nextAttemptAt: null,
            },
          });
        } else {
          await this.failed(bill, view.error ?? 'It was not sent.', view.retryable);
        }
      } catch (error) {
        // Unreachable, busy or the day's limit: later. Not set up or refused: not by trying again.
        const retryable =
          !(error instanceof ControlPlaneError) ||
          error.status === undefined ||
          error.status === 429 ||
          (error.status >= 500 && error.code !== 'DIGITAL_BILLS_NOT_SET_UP');
        await this.failed(bill, plainError(error), retryable);
      }
    }
    return due.length;
  }

  /** A try that did not send: tried again later, or given up (and the number forgotten). */
  private async failed(bill: DigitalBill, reason: string, retryable: boolean): Promise<void> {
    const attempts = bill.attempts + 1;
    const next = retryable
      ? nextDigitalBillAttempt(bill.createdAt, attempts, this.options.now())
      : undefined;
    await this.prisma.digitalBill.update({
      where: { id: bill.id },
      data:
        next === undefined
          ? { status: 'FAILED', attempts, lastError: reason, phone: null, nextAttemptAt: null }
          : { attempts, lastError: reason, nextAttemptAt: next },
    });
  }

  /** What the Control Plane needs: the bill as printed, and how long its copy is kept. */
  private async request(bill: DigitalBill): Promise<DigitalBillRequest> {
    const [invoice, restaurant, settings] = await Promise.all([
      this.prisma.invoice.findUniqueOrThrow({
        where: { id: bill.invoiceId },
        include: {
          lines: true,
          taxLines: true,
          tableSession: { select: { table: { select: { label: true } } } },
        },
      }),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: bill.restaurantId },
        select: { displayName: true, timeZone: true },
      }),
      this.settings.snapshot(bill.restaurantId),
    ]);
    const view = invoiceView({
      ...invoice,
      lines: invoice.lines.filter((line) => line.version === invoice.version),
      taxLines: invoice.taxLines.filter((line) => line.version === invoice.version),
    });
    return {
      id: bill.id,
      channel: bill.channel === 'SMS' ? 'SMS' : 'WHATSAPP',
      phone: bill.phone ?? '',
      restaurantName: restaurant.displayName.slice(0, 80),
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      grandTotal: invoice.grandTotal,
      lines: billTextLines(view, restaurant.timeZone)
        .slice(0, 600)
        .map((line) => line.slice(0, 80)),
      keepDays: settings.get('bills.hostedCopyDays'),
    };
  }
}
