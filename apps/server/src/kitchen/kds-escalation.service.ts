import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { KdsService } from './kds.service.js';

export const KDS_ESCALATION_OPTIONS = Symbol('KDS_ESCALATION_OPTIONS');

export interface KdsEscalationOptions {
  /** How often ready, uncollected food is looked for; 0 turns the sweep off (tests). */
  readonly everyMs: number;
}

export const DEFAULT_KDS_ESCALATION_OPTIONS: KdsEscalationOptions = { everyMs: 30_000 };

/**
 * Automatic escalation of ready food nobody collects (P6-05a, KDS-006 S): where
 * `kds.autoEscalateNotCollected` is on, a ticket whose ready items have waited
 * `kds.readyNotCollectedMinutes` alerts the managers as if the kitchen had pressed "Notify
 * manager", once per ticket: a manager who acknowledged it is not asked again for the same food.
 */
@Injectable()
export class KdsEscalationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KdsEscalationService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly kds: KdsService,
    @Inject(KDS_ESCALATION_OPTIONS) private readonly options: KdsEscalationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.everyMs <= 0) return;
    this.timer = setInterval(() => {
      this.running ??= this.sweep()
        .catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Ready food could not be checked for collection');
        })
        .finally(() => {
          this.running = undefined;
        });
    }, this.options.everyMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Raises what is due; returns how many tickets it alerted the managers about. */
  async sweep(now: Date = new Date()): Promise<number> {
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    let raised = 0;
    for (const { id: restaurantId } of restaurants) {
      const settings = await this.settings.snapshot(restaurantId);
      if (!settings.get('kds.autoEscalateNotCollected')) continue;
      const since = new Date(now.getTime() - settings.get('kds.readyNotCollectedMinutes') * 60_000);
      // From the dishes waiting at the pass, not from every ticket nobody bumped (P8-01a).
      const stations = await this.prisma.station.findMany({
        where: { restaurantId },
        select: { id: true },
      });
      const ready = await this.prisma.orderItem.findMany({
        where: {
          restaurantId,
          // By station and state: the index that holds today's few dishes at the pass.
          stationId: { in: stations.map((station) => station.id) },
          state: 'READY',
          readyAt: { lte: since },
        },
        select: { kotLines: { select: { kotId: true } } },
      });
      const kotIds = [...new Set(ready.flatMap((item) => item.kotLines.map((line) => line.kotId)))];
      const waiting =
        kotIds.length === 0
          ? []
          : await this.prisma.kot.findMany({
              where: { restaurantId, id: { in: kotIds }, bumpedAt: null },
              select: { id: true },
            });
      if (waiting.length === 0) continue;
      // Once per ticket, whether that alert is still open or was dealt with.
      const raisedBefore = new Set(
        (
          await this.prisma.alert.findMany({
            where: {
              restaurantId,
              dedupeKey: { in: waiting.map((kot) => `collect:${kot.id}`) },
            },
            select: { dedupeKey: true },
          })
        ).map((alert) => alert.dedupeKey),
      );
      for (const kot of waiting) {
        if (raisedBefore.has(`collect:${kot.id}`)) continue;
        if (await this.kds.escalateNotCollected(restaurantId, kot.id)) raised += 1;
      }
    }
    return raised;
  }
}
