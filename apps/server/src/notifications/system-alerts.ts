import { statfs } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { NOTIFICATION_OPTIONS, type NotificationOptions } from './clock.js';
import { NotificationsService } from './notifications.service.js';

export interface DiskUsage {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/**
 * Alerts about the server PC itself (NTF-003, Appendix C): the data drive filling up goes to the
 * Owner and managers daily until space is freed. Backup failures (P7-06) and licence changes
 * (P7-01) raise `DISK_OR_BACKUP` and `LICENSE_STATE` through the same engine when they exist.
 */
@Injectable()
export class SystemAlerts implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemAlerts.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationOptions,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.options.systemCheckMs ?? 0;
    if (every <= 0) return;
    this.timer = setInterval(() => {
      this.checkDisk().catch((error: unknown) => {
        this.logger.error(`Disk check failed: ${String(error)}`);
      });
    }, every);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Raises or clears the disk alert for every restaurant on this server. */
  async checkDisk(usage?: DiskUsage): Promise<{ usedPercent: number } | null> {
    const disk = usage ?? (await this.readDisk());
    if (disk === null || disk.totalBytes <= 0) return null;
    const usedPercent = Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    for (const { id } of restaurants) {
      const settings = await this.notifications.settingsOf(id);
      const full = usedPercent >= settings.get('notifications.diskAlertPercent');
      await this.prisma.transaction(async (tx) => {
        if (full) {
          await this.notifications.raise(tx, {
            restaurantId: id,
            type: 'DISK_OR_BACKUP',
            dedupeKey: 'disk',
            payload: { usedPercent, freeBytes: disk.freeBytes },
          });
        } else {
          await this.notifications.clear(tx, { restaurantId: id, dedupeKey: 'disk' });
        }
      });
    }
    return { usedPercent };
  }

  private async readDisk(): Promise<DiskUsage | null> {
    try {
      const stats = await statfs(this.config.dataDir);
      return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
    } catch {
      return null;
    }
  }
}
