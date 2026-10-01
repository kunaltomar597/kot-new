import { Injectable } from '@nestjs/common';
import type {
  DeviceHealthRequest,
  KioskExitRequest,
  KioskExitResponse,
  TabletTableView,
} from '@rp/contracts';
import { isLowBattery } from '@rp/domain';
import { AuthService } from '../auth/auth.service.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { SettingsService } from '../settings/settings.service.js';

const errors = {
  notATablet: () => new AppError(403, 'NOT_A_TABLE_TABLET', 'Only a table tablet can do this.'),
  notBound: () =>
    new AppError(
      409,
      'TABLET_NOT_BOUND',
      'This tablet is not bound to a table. Ask a manager to choose its table on the dashboard.',
    ),
  pager: () =>
    new AppError(403, 'PAGER_HEALTH_OVER_MQTT', 'Pagers report their battery in their heartbeat.'),
};

/** The device types whose battery and connection alert the managers (Appendix C). */
const ALERTING = new Set(['TABLE_TABLET', 'KDS']);

/**
 * What a table tablet needs from the server beyond ordering (P3-01a): its own table and whether a
 * session is open (TAB-002, TAB-003, AUTH-009), the health reports every app sends (TAB-015), and
 * the manager's PIN that lets staff out of kiosk mode (TAB-001).
 */
@Injectable()
export class TabletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
  ) {}

  async table(device: AuthenticatedDevice): Promise<TabletTableView> {
    if (device.type !== 'TABLE_TABLET') throw errors.notATablet();
    if (device.tableId === null) throw errors.notBound();
    const table = await this.prisma.diningTable.findFirst({
      where: { id: device.tableId, restaurantId: device.restaurantId, archivedAt: null },
      select: { id: true, label: true, state: true },
    });
    if (table === null) throw errors.notBound();
    const session = await this.prisma.tableSession.findFirst({
      where: { restaurantId: device.restaurantId, tableId: table.id, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
      select: { id: true, openedAt: true, covers: true },
    });
    const snapshot = await this.settings.snapshot(device.restaurantId);
    const show = snapshot.get('tablet.idleShowsPromotions');
    const pinned = Object.entries(snapshot.get('reco.itemPreferences')).flatMap(
      ([itemId, preference]) => (preference === 'PIN' ? [itemId] : []),
    );
    const live =
      !show || pinned.length === 0
        ? []
        : await this.prisma.item.findMany({
            where: {
              id: { in: pinned },
              restaurantId: device.restaurantId,
              archivedAt: null,
              available: true,
              channels: { has: 'TABLE_TABLET' },
            },
            // Menu order: settings keep no order of their own.
            orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
            select: { id: true },
          });
    return {
      tableId: table.id,
      label: table.label,
      state: table.state,
      session:
        session === null
          ? null
          : { id: session.id, openedAt: session.openedAt.toISOString(), covers: session.covers },
      promotions: { show, itemIds: live.map((item) => item.id) },
    };
  }

  /**
   * Records what an app says about itself. Managers hear about it (`DeviceStatusChanged`) only
   * when something they act on changed: low battery started or ended, charging, or the kind of
   * connection; a low, unplugged tablet or kitchen screen then alerts them once (Appendix C).
   */
  async reportHealth(device: AuthenticatedDevice, health: DeviceHealthRequest): Promise<void> {
    if (device.type === 'PAGER') throw errors.pager();
    const threshold = (await this.settings.snapshot(device.restaurantId)).get(
      'devices.lowBatteryAlertPercent',
    );
    const low = (battery: number | null, charging: boolean | null) =>
      isLowBattery(battery, threshold) && charging !== true;
    await this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM devices WHERE id = ${device.deviceId}::uuid FOR UPDATE`;
      const before = await tx.device.findUniqueOrThrow({
        where: { id: device.deviceId },
        select: { batteryPercent: true, charging: true, network: true },
      });
      const now = new Date();
      await tx.device.update({
        where: { id: device.deviceId },
        data: {
          batteryPercent: health.batteryPercent,
          charging: health.charging,
          network: health.network,
          rssi: health.rssi,
          lastSeenAt: now,
          ...(health.appVersion !== undefined && { appVersion: health.appVersion }),
        },
      });
      const changed =
        low(before.batteryPercent, before.charging) !==
          low(health.batteryPercent, health.charging) ||
        before.charging !== health.charging ||
        before.network !== health.network;
      if (changed && ALERTING.has(device.type)) await this.announce(tx, device, health, now);
    });
  }

  async exitKiosk(
    device: AuthenticatedDevice,
    request: KioskExitRequest,
  ): Promise<KioskExitResponse> {
    if (device.type !== 'TABLE_TABLET') throw errors.notATablet();
    const { approver, exitedAt } = await this.auth.kioskExit(device, request.staffId, request.pin);
    return {
      approver: { id: approver.id, displayName: approver.displayName },
      exitedAt: exitedAt.toISOString(),
    };
  }

  private async announce(
    tx: TransactionClient,
    device: AuthenticatedDevice,
    health: DeviceHealthRequest,
    now: Date,
  ): Promise<void> {
    await appendEvent(
      tx,
      {
        eventId: newId(),
        type: 'DeviceStatusChanged',
        version: 1,
        occurredAt: now.toISOString(),
        restaurantId: device.restaurantId,
        businessDate: await currentBusinessDate(tx, device.restaurantId, now),
        payload: {
          deviceId: device.deviceId,
          deviceType: device.type,
          online: true,
          ...(health.batteryPercent !== null && { batteryPercent: health.batteryPercent }),
          ...(health.charging !== null && { charging: health.charging }),
        },
      },
      { aggregate: { type: 'device', id: device.deviceId } },
    );
  }
}
