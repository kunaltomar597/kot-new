import { Injectable } from '@nestjs/common';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { appendEvent } from '../events/outbox.js';
import type { Printer, Station } from '../generated/prisma/client.js';

type RoutablePrinter = Pick<Printer, 'id' | 'archivedAt' | 'redirectToId'>;
type RoutableStation = Pick<Station, 'id' | 'mode' | 'printerId'>;

/**
 * The printer a station's paper goes to right now (KDS-008): none for a screen-only station or
 * one without an active printer; the redirect target while a manager has set one and it is active.
 * Redirects are one step only (the redirect endpoint refuses chains).
 */
export function effectivePrinterId(
  station: RoutableStation,
  printers: ReadonlyMap<string, RoutablePrinter>,
): string | null {
  if (station.mode === 'SCREEN' || station.printerId === null) return null;
  const own = printers.get(station.printerId);
  if (own?.archivedAt !== null) return null;
  if (own.redirectToId !== null) {
    const target = printers.get(own.redirectToId);
    if (target?.archivedAt === null) return target.id;
  }
  return own.id;
}

/** Tickets waiting to print: new ones and ones that failed and will be tried again. */
export const WAITING = ['PENDING', 'FAILED'] as const;

/**
 * Printer health (P1-07b, KDS-008, NTF-003). A failed job marks the printer offline and alerts
 * the POS and managers with `PrinterStatusChanged`; the next job it takes marks it online and
 * says so. Only changes are announced, so a printer that stays offline alerts once.
 */
@Injectable()
export class PrinterStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /** Station id → the printer its paper goes to, for one restaurant. */
  async routing(
    client: Pick<TransactionClient, 'station' | 'printer'>,
    restaurantId: string,
  ): Promise<Map<string, string>> {
    const [stations, printers] = await Promise.all([
      client.station.findMany({
        where: { restaurantId },
        select: { id: true, mode: true, printerId: true },
      }),
      client.printer.findMany({
        where: { restaurantId },
        select: { id: true, archivedAt: true, redirectToId: true },
      }),
    ]);
    const byId = new Map(printers.map((printer) => [printer.id, printer]));
    const routes = new Map<string, string>();
    for (const station of stations) {
      const printerId = effectivePrinterId(station, byId);
      if (printerId !== null) routes.set(station.id, printerId);
    }
    return routes;
  }

  /** How many tickets and notes wait for each printer. */
  async queuedByPrinter(
    client: Pick<TransactionClient, 'station' | 'printer' | 'kot' | 'printNotice'>,
    restaurantId: string,
  ): Promise<Map<string, number>> {
    const routes = await this.routing(client, restaurantId);
    const [kots, notices] = await Promise.all([
      client.kot.groupBy({
        by: ['stationId'],
        where: { restaurantId, printStatus: { in: [...WAITING] } },
        _count: { _all: true },
      }),
      client.printNotice.groupBy({
        by: ['stationId'],
        where: { restaurantId, printStatus: { in: [...WAITING] } },
        _count: { _all: true },
      }),
    ]);
    const queued = new Map<string, number>();
    for (const row of [...kots, ...notices]) {
      const printerId = routes.get(row.stationId);
      if (printerId !== undefined) {
        queued.set(printerId, (queued.get(printerId) ?? 0) + row._count._all);
      }
    }
    return queued;
  }

  /** The printer took a job: record it, and announce it if it was offline. */
  async markOnline(printerId: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const printer = await this.lock(tx, printerId);
      if (printer === null) return;
      await tx.printer.update({
        where: { id: printerId },
        data: { lastSeenAt: new Date(), offlineSince: null, lastError: null },
      });
      if (printer.offlineSince !== null) await this.announce(tx, printer, true, null);
    });
  }

  /** A job failed: record why, and announce it if the printer was online. */
  async markOffline(printerId: string, error: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const printer = await this.lock(tx, printerId);
      if (printer === null) return;
      await tx.printer.update({
        where: { id: printerId },
        data: { offlineSince: printer.offlineSince ?? new Date(), lastError: error },
      });
      if (printer.offlineSince === null) await this.announce(tx, printer, false, error);
    });
  }

  private async lock(tx: TransactionClient, printerId: string): Promise<Printer | null> {
    await tx.$queryRaw`SELECT 1 AS locked FROM printers WHERE id = ${printerId}::uuid FOR UPDATE`;
    return tx.printer.findUnique({ where: { id: printerId } });
  }

  private async announce(
    tx: TransactionClient,
    printer: Printer,
    online: boolean,
    error: string | null,
  ): Promise<void> {
    const queued = await this.queuedByPrinter(tx, printer.restaurantId);
    await appendEvent(
      tx,
      {
        eventId: newId(),
        type: 'PrinterStatusChanged',
        version: 1,
        occurredAt: new Date().toISOString(),
        restaurantId: printer.restaurantId,
        businessDate: await currentBusinessDate(tx, printer.restaurantId),
        payload: {
          printerId: printer.id,
          printerName: printer.name,
          online,
          error: error?.slice(0, 300) ?? null,
          queued: queued.get(printer.id) ?? 0,
        },
      },
      { aggregate: { type: 'printer', id: printer.id } },
    );
  }
}
