import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { PrintQueueResponse, TestPrintResponse } from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { EventBus } from '../events/event-bus.js';
import type { Printer } from '../generated/prisma/client.js';
import { paperWidthOf, renderNotice } from './escpos.js';
import { KotTicketsService } from './kot-tickets.service.js';
import { PrinterStatusService, WAITING } from './printer-status.service.js';
import { PrintFailure, PrinterTransport } from './printer-transport.js';

export const PRINT_QUEUE_OPTIONS = Symbol('PRINT_QUEUE_OPTIONS');

export interface PrintQueueOptions {
  /** How often the queue looks for work besides being woken by new tickets; 0 turns it off. */
  readonly intervalMs: number;
  /** First wait after a printer fails; it doubles with each further failure. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_PRINT_QUEUE_OPTIONS: PrintQueueOptions = {
  intervalMs: 2_000,
  retryBaseMs: 2_000,
  retryMaxMs: 60_000,
};

/** Tests drive the queue with `drain()` so nothing prints behind their back. */
export const TEST_PRINT_QUEUE_OPTIONS: PrintQueueOptions = {
  ...DEFAULT_PRINT_QUEUE_OPTIONS,
  intervalMs: 0,
};

interface Job {
  readonly type: 'KOT' | 'NOTICE';
  readonly id: string;
  readonly restaurantId: string;
  readonly stationId: string;
  readonly createdAt: Date;
}

export interface DrainResult {
  readonly printed: number;
  readonly failed: number;
}

const KOT_TRIGGERS = new Set(['KotCreated', 'TableMoved']);

/**
 * The print queue (P1-07b, KDS-008, NFR-P02, NTF-003). Tickets and notes for printing stations
 * wait as PENDING; the queue prints them in the order they were raised, per printer, and marks
 * them PRINTED. When a printer fails, its job is marked FAILED and stays queued, the printer is
 * marked offline (the POS and managers are alerted once), and it is tried again with a growing
 * wait; the first job it takes brings it back online. A manager can redirect a broken printer's
 * queue to another printer. Printing is at least once: a job the printer took just before the
 * server stopped may print again.
 */
@Injectable()
export class PrintQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PrintQueueService.name);
  /** Printer id → consecutive failures and when to try again. */
  private readonly backoff = new Map<string, { failures: number; retryAt: number }>();
  private running: Promise<DrainResult> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tickets: KotTicketsService,
    private readonly status: PrinterStatusService,
    private readonly transport: PrinterTransport,
    private readonly events: EventBus,
    @Inject(PRINT_QUEUE_OPTIONS) private readonly options: PrintQueueOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.intervalMs <= 0) return;
    // New tickets print straight away (NFR-P02: within 3 s); the interval catches the rest.
    this.unsubscribe = this.events.onPublished((published) => {
      if (published.some(({ event }) => KOT_TRIGGERS.has(event.type))) this.wake();
    });
    this.timer = setInterval(() => {
      this.wake();
    }, this.options.intervalMs);
    this.timer.unref();
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    await this.running;
  }

  /** Asks for a pass soon; passes never overlap. Off when the queue is driven by hand (tests). */
  wake(): void {
    if (this.stopped || this.options.intervalMs <= 0) return;
    void this.drain().catch((error: unknown) => {
      this.logger.error(`Print queue pass failed: ${String(error)}`);
    });
  }

  /** Prints what is waiting, one printer at a time in parallel. */
  drain(): Promise<DrainResult> {
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = undefined;
      if (this.again && !this.stopped) {
        this.again = false;
        this.wake();
      }
    });
    return this.running;
  }

  /** Printers with their state and how much waits for them (the POS banner). */
  async queue(restaurantId: string): Promise<PrintQueueResponse> {
    const [printers, queued] = await Promise.all([
      this.prisma.printer.findMany({
        where: { restaurantId, archivedAt: null },
        orderBy: { name: 'asc' },
      }),
      this.status.queuedByPrinter(this.prisma, restaurantId),
    ]);
    return {
      printers: printers.map((printer) => ({
        printerId: printer.id,
        name: printer.name,
        online: printer.offlineSince === null,
        offlineSince: printer.offlineSince?.toISOString() ?? null,
        lastError: printer.lastError,
        redirectToId: printer.redirectToId,
        queued: queued.get(printer.id) ?? 0,
      })),
    };
  }

  /** Forgets the wait after a printer's failure, e.g. when a manager redirects or tests it. */
  retrySoon(printerId: string): void {
    this.backoff.delete(printerId);
    this.wake();
  }

  /**
   * Prints a ticket again now (KDS-008), marked REPRINT, on the chosen printer or where its
   * station prints. A ticket still waiting counts as printed once this succeeds.
   */
  async reprint(
    principal: Principal,
    kotId: string,
    request: { printerId: string | null; reason: string },
  ): Promise<TestPrintResponse> {
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, restaurantId: principal.restaurantId },
      select: { id: true, stationId: true, kotNumber: true, printStatus: true },
    });
    if (kot === null) throw new AppError(404, 'KOT_NOT_FOUND', 'There is no such ticket.');
    const printer = await this.reprintTarget(principal.restaurantId, kot.stationId, request);
    const rendered = await this.tickets.render(principal.restaurantId, kot.id, {
      reprint: true,
      paperWidthMm: paperWidthOf(printer),
    });
    const error = await this.send(printer, rendered.bytes);
    await this.updateHealth(printer.id, error);
    await this.prisma.transaction(async (tx) => {
      if (error === null && kot.printStatus !== 'PRINTED' && kot.printStatus !== 'NOT_REQUIRED') {
        await tx.kot.update({
          where: { id: kot.id },
          data: { printStatus: 'PRINTED', printedAt: new Date() },
        });
      }
      await this.audit.record(tx, {
        action: 'KOT_REPRINTED',
        entityType: 'kot',
        entityId: kot.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: null,
        after: { kotNumber: kot.kotNumber, printerId: printer.id, printed: error === null },
        reason: request.reason,
      });
    });
    return { printed: error === null, error };
  }

  private async reprintTarget(
    restaurantId: string,
    stationId: string,
    request: { printerId: string | null },
  ): Promise<Printer> {
    let printerId = request.printerId;
    if (printerId === null) {
      printerId = (await this.status.routing(this.prisma, restaurantId)).get(stationId) ?? null;
      if (printerId === null) {
        throw new AppError(
          422,
          'NO_PRINTER',
          'This station has no printer. Choose a printer to print the ticket on.',
        );
      }
    }
    const printer = await this.prisma.printer.findFirst({
      where: { id: printerId, restaurantId, archivedAt: null },
    });
    if (printer === null) {
      throw new AppError(422, 'PRINTER_NOT_FOUND', 'There is no such active printer.');
    }
    return printer;
  }

  /** Sends bytes; returns why they did not print, if they did not. */
  private async send(printer: Printer, bytes: Uint8Array): Promise<string | null> {
    try {
      await this.transport.send(
        { connection: printer.connection, host: printer.host ?? '', port: printer.port },
        bytes,
      );
      return null;
    } catch (error) {
      if (!(error instanceof PrintFailure)) throw error;
      return error.message;
    }
  }

  /** After the job is recorded, so the alert counts what still waits. */
  private async updateHealth(printerId: string, error: string | null): Promise<void> {
    if (error === null) await this.status.markOnline(printerId);
    else await this.status.markOffline(printerId, error);
  }

  private async pass(): Promise<DrainResult> {
    const [kots, notices] = await Promise.all([
      this.prisma.kot.findMany({
        where: { printStatus: { in: [...WAITING] } },
        select: { id: true, restaurantId: true, stationId: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { kotNumber: 'asc' }],
        take: 500,
      }),
      this.prisma.printNotice.findMany({
        where: { printStatus: { in: [...WAITING] } },
        select: { id: true, restaurantId: true, stationId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
    ]);
    const jobs: Job[] = [
      ...kots.map((kot) => ({ type: 'KOT' as const, ...kot })),
      ...notices.map((notice) => ({ type: 'NOTICE' as const, ...notice })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (jobs.length === 0) return { printed: 0, failed: 0 };

    // Group by the printer each job goes to now; jobs with nowhere to print wait.
    const routes = new Map<string, Map<string, string>>();
    const byPrinter = new Map<string, Job[]>();
    for (const job of jobs) {
      let restaurantRoutes = routes.get(job.restaurantId);
      if (restaurantRoutes === undefined) {
        restaurantRoutes = await this.status.routing(this.prisma, job.restaurantId);
        routes.set(job.restaurantId, restaurantRoutes);
      }
      const printerId = restaurantRoutes.get(job.stationId);
      if (printerId !== undefined)
        byPrinter.set(printerId, [...(byPrinter.get(printerId) ?? []), job]);
    }

    const results = await Promise.all(
      [...byPrinter].map(([printerId, printerJobs]) => this.printAll(printerId, printerJobs)),
    );
    return results.reduce(
      (total, result) => ({
        printed: total.printed + result.printed,
        failed: total.failed + result.failed,
      }),
      { printed: 0, failed: 0 },
    );
  }

  /** One printer's jobs in order; stops at the first failure so the order is kept. */
  private async printAll(printerId: string, jobs: readonly Job[]): Promise<DrainResult> {
    const wait = this.backoff.get(printerId);
    if (wait !== undefined && Date.now() < wait.retryAt) return { printed: 0, failed: 0 };
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (printer === null) return { printed: 0, failed: 0 };
    let printed = 0;
    for (const job of jobs) {
      const bytes = await this.render(job, printer);
      const error = await this.send(printer, bytes);
      await this.recordAttempt(job, error === null);
      await this.updateHealth(printerId, error);
      if (error !== null) {
        const failures = (wait?.failures ?? 0) + 1;
        const delay = Math.min(
          this.options.retryBaseMs * 2 ** (failures - 1),
          this.options.retryMaxMs,
        );
        this.backoff.set(printerId, { failures, retryAt: Date.now() + delay });
        this.logger.warn(`Printer ${printer.name} failed; retrying in ${String(delay)} ms`);
        return { printed, failed: 1 };
      }
      this.backoff.delete(printerId);
      printed += 1;
    }
    return { printed, failed: 0 };
  }

  private async render(job: Job, printer: Printer): Promise<Uint8Array> {
    const paperWidthMm = paperWidthOf(printer);
    if (job.type === 'KOT') {
      return (await this.tickets.render(job.restaurantId, job.id, { paperWidthMm })).bytes;
    }
    const notice = await this.prisma.printNotice.findUniqueOrThrow({
      where: { id: job.id },
      include: { station: { select: { name: true } } },
    });
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: job.restaurantId },
      select: { timeZone: true },
    });
    const lines = Array.isArray(notice.lines)
      ? notice.lines.filter((line): line is string => typeof line === 'string')
      : [];
    return renderNotice(
      {
        title: notice.title,
        lines,
        stationName: notice.station.name,
        createdAt: notice.createdAt,
        timeZone: restaurant.timeZone,
      },
      paperWidthMm,
    );
  }

  private async recordAttempt(job: Job, printed: boolean): Promise<void> {
    const data = printed
      ? { printStatus: 'PRINTED' as const, printedAt: new Date(), printAttempts: { increment: 1 } }
      : { printStatus: 'FAILED' as const, printAttempts: { increment: 1 } };
    if (job.type === 'KOT') {
      await this.prisma.kot.update({ where: { id: job.id }, data });
    } else {
      await this.prisma.printNotice.update({ where: { id: job.id }, data });
    }
  }
}
