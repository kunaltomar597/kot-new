import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { AuthenticatedDevice } from '../auth/device.js';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService } from '../database/prisma.service.js';
import { appendEvent } from '../events/outbox.js';
import type { DeviceType } from '../generated/prisma/enums.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { SettingsService } from '../settings/settings.service.js';

export const DEVICE_LIVENESS_OPTIONS = Symbol('DEVICE_LIVENESS_OPTIONS');

export interface DeviceLivenessOptions {
  /** How often disconnected screens and tablets are held against the grace period; 0 never. */
  readonly checkMs: number;
}

export const DEFAULT_DEVICE_LIVENESS_OPTIONS: DeviceLivenessOptions = { checkMs: 5_000 };

/** The devices whose absence is an alert (NTF-003); pagers report through their heartbeats. */
const WATCHED: readonly DeviceType[] = ['KDS', 'TABLE_TABLET'];

interface WatchedDevice {
  readonly id: string;
  readonly restaurantId: string;
  readonly type: DeviceType;
  readonly batteryPercent: number | null;
}

/**
 * Whether each kitchen screen and table tablet is connected (NTF-003, MGR-006), kept in the
 * device's `online` as the pager broker keeps it for pagers. A device that connects is online at
 * once; one whose last live connection closed goes offline only after
 * `devices.offlineAfterSeconds`, so a reload or a moment out of Wi-Fi raises nothing. Each change
 * is announced with `DeviceStatusChanged`, which the notification triggers turn into one alert per
 * state. After a restart the grace counts from the start, giving every device time to reconnect.
 */
@Injectable()
export class DeviceLiveness implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeviceLiveness.name);
  /** When each watched device's last live connection closed, since this server started. */
  private readonly disconnectedAt = new Map<string, number>();
  /** When this server began watching: a device stored online gets its grace from here. */
  readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private stopListening: (() => void) | undefined;
  private checking: Promise<number> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly settings: SettingsService,
    @Inject(DEVICE_LIVENESS_OPTIONS) private readonly options: DeviceLivenessOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.stopListening = this.gateway.onConnectionChange((device, connected) => {
      this.connectionChanged(device, connected);
    });
    if (this.options.checkMs <= 0) return;
    this.timer = setInterval(() => {
      this.checking ??= this.check()
        .catch((error: unknown) => {
          this.logger.error(`Device connection check failed: ${String(error)}`);
          return 0;
        })
        .finally(() => {
          this.checking = undefined;
        });
    }, this.options.checkMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.stopListening?.();
    await this.checking;
  }

  /**
   * Holds every watched device against its state: connected but stored offline (the connection
   * was missed) becomes online; disconnected for longer than the grace becomes offline. Returns
   * how many changed.
   */
  async check(now: Date = new Date()): Promise<number> {
    const devices = await this.prisma.device.findMany({
      where: { type: { in: [...WATCHED] }, status: 'ACTIVE' },
      select: { id: true, restaurantId: true, type: true, online: true, batteryPercent: true },
    });
    const graces = new Map<string, number>();
    let changed = 0;
    for (const device of devices) {
      if (this.gateway.isDeviceConnected(device.restaurantId, device.id)) {
        if (!device.online && (await this.announce(device, true, now))) changed += 1;
        continue;
      }
      if (!device.online) continue;
      let graceMs = graces.get(device.restaurantId);
      if (graceMs === undefined) {
        const settings = await this.settings.snapshot(device.restaurantId);
        graceMs = settings.get('devices.offlineAfterSeconds') * 1_000;
        graces.set(device.restaurantId, graceMs);
      }
      const gone = Math.max(this.startedAt, this.disconnectedAt.get(device.id) ?? 0);
      if (now.getTime() - gone < graceMs) continue;
      if (await this.announce(device, false, now)) changed += 1;
    }
    return changed;
  }

  private connectionChanged(device: AuthenticatedDevice, connected: boolean): void {
    if (!WATCHED.includes(device.type)) return;
    if (!connected) {
      this.disconnectedAt.set(device.deviceId, Date.now());
      return;
    }
    this.disconnectedAt.delete(device.deviceId);
    const watched = {
      id: device.deviceId,
      restaurantId: device.restaurantId,
      type: device.type,
    };
    this.prisma.device
      .findUnique({ where: { id: device.deviceId }, select: { batteryPercent: true } })
      .then((row) =>
        this.announce({ ...watched, batteryPercent: row?.batteryPercent ?? null }, true),
      )
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Could not record that a device connected');
      });
  }

  /**
   * Stores the new state and announces it, unless it is already stored (two checks, or a check
   * and a connection, racing): only the one that changes `online` says so.
   */
  private announce(device: WatchedDevice, online: boolean, now = new Date()): Promise<boolean> {
    return this.prisma.transaction(async (tx) => {
      const { count } = await tx.device.updateMany({
        where: { id: device.id, status: 'ACTIVE', online: !online },
        data: { online },
      });
      if (count === 0) return false;
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
            deviceId: device.id,
            deviceType: device.type,
            online,
            ...(device.batteryPercent !== null && { batteryPercent: device.batteryPercent }),
          },
        },
        { aggregate: { type: 'device', id: device.id } },
      );
      return true;
    });
  }
}
