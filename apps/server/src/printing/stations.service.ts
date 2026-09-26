import { Injectable } from '@nestjs/common';
import type { StationRequest, StationView } from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Station } from '../generated/prisma/client.js';
import { announceSetupChange, lockSetup } from '../restaurant/setup-changes.js';

export function toStationView(station: Station): StationView {
  return {
    id: station.id,
    name: station.name,
    mode: station.mode,
    printerId: station.printerId,
    archivedAt: station.archivedAt?.toISOString() ?? null,
  };
}

function snapshot(station: Pick<Station, 'name' | 'mode' | 'printerId'>): Record<string, unknown> {
  return { name: station.name, mode: station.mode, printerId: station.printerId };
}

function stationNotFound(): AppError {
  return new AppError(404, 'STATION_NOT_FOUND', 'There is no such station.');
}

/**
 * Kitchen stations (P1-07a, KDS-002, KDS-008, ONB-004 step 6). Each one shows its tickets on the
 * kitchen screen, prints them, or both; a station that prints names its printer. Managers and the
 * Owner change them (BRD §4.2); every change is audited (AUD-001) and announced with
 * `RestaurantChanged { part: 'STATIONS' }`. Stations are archived, never deleted, and only when no
 * active menu item and no kitchen screen uses them any more.
 */
@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string): Promise<StationView[]> {
    const stations = await this.prisma.station.findMany({
      where: { restaurantId },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return stations.map(toStationView);
  }

  create(principal: Principal, request: StationRequest): Promise<StationView> {
    return this.change(principal, async (tx) => {
      await this.assertNameFree(tx, principal.restaurantId, request.name, null);
      const printerId = await this.printerFor(tx, principal.restaurantId, request);
      const station = await tx.station.create({
        data: {
          restaurantId: principal.restaurantId,
          name: request.name,
          mode: request.mode,
          printerId,
        },
      });
      await this.record(tx, principal, 'STATION_CREATED', station.id, {
        before: null,
        after: snapshot(station),
      });
      return { changed: true, station };
    });
  }

  update(principal: Principal, stationId: string, request: StationRequest): Promise<StationView> {
    return this.change(principal, async (tx) => {
      const existing = await this.find(tx, principal.restaurantId, stationId);
      if (existing.archivedAt !== null) {
        throw new AppError(409, 'STATION_ARCHIVED', 'This station is archived.');
      }
      await this.assertNameFree(tx, principal.restaurantId, request.name, stationId);
      const printerId = await this.printerFor(tx, principal.restaurantId, request);
      if (
        existing.name === request.name &&
        existing.mode === request.mode &&
        existing.printerId === printerId
      ) {
        return { changed: false, station: existing };
      }
      const station = await tx.station.update({
        where: { id: stationId },
        data: { name: request.name, mode: request.mode, printerId },
      });
      await this.record(tx, principal, 'STATION_CHANGED', stationId, {
        before: snapshot(existing),
        after: snapshot(station),
      });
      return { changed: true, station };
    });
  }

  archive(principal: Principal, stationId: string, reason: string): Promise<StationView> {
    return this.change(principal, async (tx) => {
      const existing = await this.find(tx, principal.restaurantId, stationId);
      if (existing.archivedAt !== null) return { changed: false, station: existing };
      const [itemCount, screenCount] = await Promise.all([
        tx.item.count({ where: { stationId, archivedAt: null } }),
        tx.device.count({ where: { stationId, status: 'ACTIVE' } }),
      ]);
      if (itemCount > 0 || screenCount > 0) {
        throw new AppError(
          409,
          'STATION_IN_USE',
          `${String(itemCount)} menu items and ${String(screenCount)} kitchen screens still use this station. Move them to another station first.`,
          { itemCount, screenCount },
        );
      }
      const station = await tx.station.update({
        where: { id: stationId },
        data: { archivedAt: new Date() },
      });
      await this.record(tx, principal, 'STATION_ARCHIVED', stationId, {
        before: { archivedAt: null },
        after: { archivedAt: station.archivedAt?.toISOString() ?? null },
        reason,
      });
      return { changed: true, station };
    });
  }

  private async change(
    principal: Principal,
    work: (tx: TransactionClient) => Promise<{ changed: boolean; station: Station }>,
  ): Promise<StationView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const { changed, station } = await work(tx);
      if (changed) {
        await announceSetupChange(tx, principal.restaurantId, 'STATIONS', {
          type: 'station',
          id: station.id,
        });
      }
      return toStationView(station);
    });
  }

  private async find(
    tx: TransactionClient,
    restaurantId: string,
    stationId: string,
  ): Promise<Station> {
    const station = await tx.station.findFirst({ where: { id: stationId, restaurantId } });
    if (station === null) throw stationNotFound();
    return station;
  }

  /** The printer a station prints on; a screen-only station keeps none. */
  private async printerFor(
    tx: TransactionClient,
    restaurantId: string,
    request: StationRequest,
  ): Promise<string | null> {
    if (request.mode === 'SCREEN' || request.printerId === null) return null;
    const printer = await tx.printer.findFirst({
      where: { id: request.printerId, restaurantId, archivedAt: null },
      select: { id: true },
    });
    if (printer === null) {
      throw new AppError(
        422,
        'PRINTER_NOT_FOUND',
        'There is no such active printer. Choose another printer, or add it first.',
      );
    }
    return printer.id;
  }

  /** Tickets and screens name the station, so two active stations with one name would confuse. */
  private async assertNameFree(
    tx: TransactionClient,
    restaurantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.station.findFirst({
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
        'STATION_NAME_TAKEN',
        `Another station is called "${name}". Choose another name.`,
      );
    }
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    stationId: string,
    change: { before: unknown; after: unknown; reason?: string },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'station',
      entityId: stationId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: change.before,
      after: change.after,
      reason: change.reason ?? null,
    });
  }
}
