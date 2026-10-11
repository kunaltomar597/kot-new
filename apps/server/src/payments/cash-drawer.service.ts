import { Injectable, Logger } from '@nestjs/common';
import type { OpenCashDrawerResponse } from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Printer } from '../generated/prisma/client.js';
import { renderDrawerKick } from '../printing/escpos.js';
import { PrinterStatusService } from '../printing/printer-status.service.js';
import { PrintFailure, PrinterTransport } from '../printing/printer-transport.js';
import { SettingsService } from '../settings/settings.service.js';
import { ShiftsService } from './shifts.service.js';

/**
 * The cash drawer on the receipt printer (P4-07b, BILL-016). Cash payments open it on their own
 * when `bills.cashDrawerKick` is on; opening it without a sale takes a reason and is audited
 * (`CASH_DRAWER_OPENED`), so the suspicious-activity report lists every such opening (AUD-006).
 */
@Injectable()
export class CashDrawerService {
  private readonly logger = new Logger(CashDrawerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly shifts: ShiftsService,
    private readonly transport: PrinterTransport,
    private readonly printerStatus: PrinterStatusService,
  ) {}

  /** A no-sale opening: kicks the drawer and, once it opened, records who, where and why. */
  async openWithoutSale(
    principal: Principal,
    reason: string,
    printerId: string | undefined,
  ): Promise<OpenCashDrawerResponse> {
    const chosen =
      printerId ?? (await this.settings.snapshot(principal.restaurantId)).get('bills.printerId');
    if (chosen === null) {
      throw new AppError(
        422,
        'NO_BILL_PRINTER',
        'No bill printer is set. Set the bill printer in settings: the drawer opens through it.',
      );
    }
    const printer = await this.printerOf(principal.restaurantId, chosen);
    if (printer === null) {
      throw new AppError(422, 'PRINTER_NOT_FOUND', 'There is no such active printer.');
    }
    const error = await this.kick(printer);
    const shift = await this.shifts.openShiftOf(this.prisma, principal);
    if (error === null) {
      await this.prisma.transaction(async (tx) => {
        await this.audit.record(tx, {
          action: 'CASH_DRAWER_OPENED',
          entityType: 'cash_drawer',
          entityId: shift?.id ?? null,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          before: null,
          after: { printerId: printer.id, shiftId: shift?.id ?? null, noSale: true },
          reason,
        });
      });
    }
    return { opened: error === null, error, printerId: printer.id, shiftId: shift?.id ?? null };
  }

  /**
   * Opens the drawer after cash was taken, when the restaurant wants that and has a bill printer.
   * It never holds up the payment: a failure is logged and the printer marked offline.
   */
  kickForCash(restaurantId: string): void {
    void (async () => {
      const snapshot = await this.settings.snapshot(restaurantId);
      const printerId = snapshot.get('bills.printerId');
      if (!snapshot.get('bills.cashDrawerKick') || printerId === null) return;
      const printer = await this.printerOf(restaurantId, printerId);
      if (printer === null) return;
      const error = await this.kick(printer);
      if (error !== null) this.logger.warn(`The cash drawer did not open: ${error}`);
    })().catch((failure: unknown) => {
      this.logger.error(`The cash drawer kick failed: ${String(failure)}`);
    });
  }

  private printerOf(restaurantId: string, printerId: string): Promise<Printer | null> {
    return this.prisma.printer.findFirst({
      where: { id: printerId, restaurantId, archivedAt: null },
    });
  }

  /** Sends the pulse; the error in words when the printer did not take it. */
  private async kick(printer: Printer): Promise<string | null> {
    try {
      await this.transport.send(
        { connection: printer.connection, host: printer.host ?? '', port: printer.port },
        renderDrawerKick(),
      );
    } catch (error) {
      if (!(error instanceof PrintFailure)) throw error;
      await this.printerStatus.markOffline(printer.id, error.message);
      return error.message;
    }
    await this.printerStatus.markOnline(printer.id);
    return null;
  }
}
