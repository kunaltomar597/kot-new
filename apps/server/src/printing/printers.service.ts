import { Injectable } from '@nestjs/common';
import type { PrinterRequest, PrinterView, TestPrintResponse } from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Printer } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';
import { type PaperWidthMm, renderTestPage } from './escpos.js';
import { PrintFailure, PrinterTransport } from './printer-transport.js';

export function toPrinterView(printer: Printer): PrinterView {
  return {
    id: printer.id,
    name: printer.name,
    connection: printer.connection,
    host: printer.host,
    port: printer.port,
    paperWidthMm: printer.paperWidthMm,
    lastSeenAt: printer.lastSeenAt?.toISOString() ?? null,
    archivedAt: printer.archivedAt?.toISOString() ?? null,
  };
}

/** Rows written before P1-07a could hold any width; anything but 58 prints as 80 mm. */
export function paperWidthOf(printer: Pick<Printer, 'paperWidthMm'>): PaperWidthMm {
  return printer.paperWidthMm === 58 ? 58 : 80;
}

function snapshot(
  printer: Pick<Printer, 'name' | 'connection' | 'host' | 'port' | 'paperWidthMm'>,
): Record<string, unknown> {
  return {
    name: printer.name,
    connection: printer.connection,
    host: printer.host,
    port: printer.port,
    paperWidthMm: printer.paperWidthMm,
  };
}

function printerNotFound(): AppError {
  return new AppError(404, 'PRINTER_NOT_FOUND', 'There is no such printer.');
}

/**
 * Printers (P1-07a, KDS-008, ONB-004 step 6): network printers on a raw TCP port or USB printers
 * shared on the server PC, ESC/POS, 80 or 58 mm paper. Managers and the Owner change them; every
 * change is audited (AUD-001) and announced with `RestaurantChanged { part: 'PRINTERS' }`. A
 * printer is archived only when no active station prints on it. The test page answers whether the
 * printer took it and records when it was last seen.
 */
@Injectable()
export class PrintersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transport: PrinterTransport,
  ) {}

  async list(restaurantId: string): Promise<PrinterView[]> {
    const printers = await this.prisma.printer.findMany({
      where: { restaurantId },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return printers.map(toPrinterView);
  }

  create(principal: Principal, request: PrinterRequest): Promise<PrinterView> {
    return this.change(principal, async (tx) => {
      await this.assertNameFree(tx, principal.restaurantId, request.name, null);
      const printer = await tx.printer.create({
        data: { restaurantId: principal.restaurantId, ...this.fields(request) },
      });
      await this.record(tx, principal, 'PRINTER_CREATED', printer.id, {
        before: null,
        after: snapshot(printer),
      });
      return { changed: true, printer };
    });
  }

  update(principal: Principal, printerId: string, request: PrinterRequest): Promise<PrinterView> {
    return this.change(principal, async (tx) => {
      const existing = await this.find(tx, principal.restaurantId, printerId);
      if (existing.archivedAt !== null) {
        throw new AppError(409, 'PRINTER_ARCHIVED', 'This printer is archived.');
      }
      await this.assertNameFree(tx, principal.restaurantId, request.name, printerId);
      const fields = this.fields(request);
      const unchanged =
        existing.name === fields.name &&
        existing.connection === fields.connection &&
        existing.host === fields.host &&
        existing.port === fields.port &&
        existing.paperWidthMm === fields.paperWidthMm;
      if (unchanged) return { changed: false, printer: existing };
      const printer = await tx.printer.update({ where: { id: printerId }, data: fields });
      await this.record(tx, principal, 'PRINTER_CHANGED', printerId, {
        before: snapshot(existing),
        after: snapshot(printer),
      });
      return { changed: true, printer };
    });
  }

  archive(principal: Principal, printerId: string, reason: string): Promise<PrinterView> {
    return this.change(principal, async (tx) => {
      const existing = await this.find(tx, principal.restaurantId, printerId);
      if (existing.archivedAt !== null) return { changed: false, printer: existing };
      const stations = await tx.station.findMany({
        where: { printerId, archivedAt: null },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      if (stations.length > 0) {
        const names = stations.map((station) => station.name);
        throw new AppError(
          409,
          'PRINTER_IN_USE',
          `These stations still print on this printer: ${names.join(', ')}. Give them another printer first.`,
          { stations: names },
        );
      }
      const printer = await tx.printer.update({
        where: { id: printerId },
        data: { archivedAt: new Date() },
      });
      await this.record(tx, principal, 'PRINTER_ARCHIVED', printerId, {
        before: { archivedAt: null },
        after: { archivedAt: printer.archivedAt?.toISOString() ?? null },
        reason,
      });
      return { changed: true, printer };
    });
  }

  /** Prints a test page (ONB-004 step 6). A failure is an answer, not an error. */
  async testPrint(principal: Principal, printerId: string): Promise<TestPrintResponse> {
    const printer = await this.prisma.printer.findFirst({
      where: { id: printerId, restaurantId: principal.restaurantId, archivedAt: null },
    });
    if (printer === null) {
      throw new AppError(404, 'PRINTER_NOT_FOUND', 'There is no such active printer.');
    }
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: principal.restaurantId },
      select: { displayName: true, timeZone: true },
    });
    const page = renderTestPage({
      restaurantName: restaurant.displayName,
      printerName: printer.name,
      paperWidthMm: paperWidthOf(printer),
      at: new Date(),
      timeZone: restaurant.timeZone,
    });
    try {
      await this.transport.send(
        { connection: printer.connection, host: printer.host ?? '', port: printer.port },
        page,
      );
    } catch (error) {
      if (error instanceof PrintFailure) return { printed: false, error: error.message };
      throw error;
    }
    await this.prisma.printer.update({
      where: { id: printer.id },
      data: { lastSeenAt: new Date() },
    });
    return { printed: true, error: null };
  }

  private fields(request: PrinterRequest): {
    name: string;
    connection: PrinterRequest['connection'];
    host: string;
    port: number | null;
    paperWidthMm: number;
  } {
    return {
      name: request.name,
      connection: request.connection,
      host: request.host,
      // A USB printer has no port; one sent anyway is dropped rather than kept by mistake.
      port: request.connection === 'NETWORK' ? request.port : null,
      paperWidthMm: request.paperWidthMm,
    };
  }

  private async change(
    principal: Principal,
    work: (tx: TransactionClient) => Promise<{ changed: boolean; printer: Printer }>,
  ): Promise<PrinterView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const { changed, printer } = await work(tx);
      if (changed) {
        await announceSetupChange(tx, principal.restaurantId, 'PRINTERS', {
          type: 'printer',
          id: printer.id,
        });
      }
      return toPrinterView(printer);
    });
  }

  private async find(
    tx: TransactionClient,
    restaurantId: string,
    printerId: string,
  ): Promise<Printer> {
    const printer = await tx.printer.findFirst({ where: { id: printerId, restaurantId } });
    if (printer === null) throw printerNotFound();
    return printer;
  }

  private async assertNameFree(
    tx: TransactionClient,
    restaurantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.printer.findFirst({
      where: {
        restaurantId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId !== null && { NOT: { id: exceptId } }),
      },
      select: { id: true },
    });
    if (clash !== null) {
      throw new AppError(
        409,
        'PRINTER_NAME_TAKEN',
        `Another printer is called "${name}". Choose another name.`,
      );
    }
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    printerId: string,
    change: { before: unknown; after: unknown; reason?: string },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'printer',
      entityId: printerId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: change.before,
      after: change.after,
      reason: change.reason ?? null,
    });
  }
}
