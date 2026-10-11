import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { appendEvent } from '../events/outbox.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { SettingsService } from '../settings/settings.service.js';

/** How often connections are compared with what the devices table says. */
export const PRESENCE_OPTIONS = Symbol('PRESENCE_OPTIONS');

export interface PresenceOptions {
  /** 0 turns the timer off (tests call `check` themselves). */
  readonly checkMs: number;
}

export const DEFAULT_PRESENCE_OPTIONS: PresenceOptions = { checkMs: 15_000 };
export const TEST_PRESENCE_OPTIONS: PresenceOptions = { checkMs: 0 };

interface WatchedDevice {
  readonly id: string;
  readonly restaurantId: string;
  readonly type: 'TABLE_TABLET' | 'KDS';
  readonly online: boolean;
  readonly batteryPercent: number | null;
  readonly charging: boolean | null;
}

/**
 * Whether table tablets and kitchen screens are connected (TAB-015, NTF-003, Appendix C "tablet
 * offline"). A device with a live connection is online at once; one away for
 * `devices.offlineAlertSeconds` (0: never) goes offline, which alerts the managers through
 * `DeviceStatusChanged`, once per change. Pagers have their own heartbeats (PGR-007).
 */
@Injectable()
export class DevicePresenceMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DevicePresenceMonitor.name);
  private readonly awaySince = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
    @Inject(PRESENCE_OPTIONS) private readonly options: PresenceOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.checkMs <= 0) return;
    this.timer = setInterval(() => {
      this.check().catch((error: unknown) => {
        this.logger.error(`Device presence check failed: ${String(error)}`);
      });
    }, this.options.checkMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Compares live connections with each device's recorded state; one check at a time. */
  check(now: number = Date.now()): Promise<void> {
    this.checking ??= this.compare(now).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async compare(now: number): Promise<void> {
    const devices = (await this.prisma.device.findMany({
      where: { status: 'ACTIVE', type: { in: ['TABLE_TABLET', 'KDS'] } },
      select: {
        id: true,
        restaurantId: true,
        type: true,
        online: true,
        batteryPercent: true,
        charging: true,
      },
    })) as WatchedDevice[];
    const byRestaurant = new Map<string, WatchedDevice[]>();
    for (const device of devices) {
      byRestaurant.set(device.restaurantId, [
        ...(byRestaurant.get(device.restaurantId) ?? []),
        device,
      ]);
    }
    const watched = new Set(devices.map((device) => device.id));
    for (const id of this.awaySince.keys()) if (!watched.has(id)) this.awaySince.delete(id);
    for (const [restaurantId, list] of byRestaurant) {
      const connected = this.realtime.connectedDeviceIds(restaurantId);
      const afterMs =
        (await this.settings.snapshot(restaurantId)).get('devices.offlineAlertSeconds') * 1_000;
      for (const device of list) {
        if (connected.has(device.id)) {
          this.awaySince.delete(device.id);
          if (!device.online) await this.mark(device, true, now);
          continue;
        }
        if (!device.online || afterMs === 0) continue;
        const since = this.awaySince.get(device.id) ?? now;
        this.awaySince.set(device.id, since);
        if (now - since >= afterMs) {
          this.awaySince.delete(device.id);
          await this.mark(device, false, now);
        }
      }
    }
  }

  private async mark(device: WatchedDevice, online: boolean, now: number): Promise<void> {
    const at = new Date(now);
    await this.prisma.transaction(async (tx) => {
      const { count } = await tx.device.updateMany({
        where: { id: device.id, online: !online },
        data: { online },
      });
      // Another check (or another server process) already recorded it.
      if (count === 0) return;
      await appendEvent(
        tx,
        {
          eventId: newId(),
          type: 'DeviceStatusChanged',
          version: 1,
          occurredAt: at.toISOString(),
          restaurantId: device.restaurantId,
          businessDate: await currentBusinessDate(tx, device.restaurantId, at),
          payload: {
            deviceId: device.id,
            deviceType: device.type,
            online,
            ...(device.batteryPercent !== null && { batteryPercent: device.batteryPercent }),
            ...(device.charging !== null && { charging: device.charging }),
          },
        },
        { aggregate: { type: 'device', id: device.id } },
      );
    });
  }
}
