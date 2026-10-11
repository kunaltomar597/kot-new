import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { addDays } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { currentBusinessDate } from '../common/business-dates.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { NOTIFICATION_CLOCK, type NotificationClock } from '../notifications/clock.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SuspiciousActivityService } from './suspicious-activity.service.js';

/** How often the daily job looks for a finished business date to report. */
export const DAILY_REPORT_OPTIONS = Symbol('DAILY_REPORT_OPTIONS');

export interface DailyReportOptions {
  /** 0 turns the timer off (tests call `runFor` themselves). */
  readonly checkMs: number;
}

export const DEFAULT_DAILY_REPORT_OPTIONS: DailyReportOptions = { checkMs: 15 * 60 * 1000 };
export const TEST_DAILY_REPORT_OPTIONS: DailyReportOptions = { checkMs: 0 };

const REPORTED = 'SUSPICIOUS_ACTIVITY_REPORTED';

export interface DailyReportOutcome {
  readonly businessDate: string;
  readonly flags: number;
  /** The Owner's alert; null when nothing was flagged. */
  readonly alertId: string | null;
}

/**
 * The daily suspicious-activity report (P4-07b, AUD-006). Once a business date is over (its
 * cut-off passed, or day-end closed it), the report runs for that date once. When it flags
 * anything the Owner gets a `SUSPICIOUS_ACTIVITY` alert with the counts; either way the run is
 * audited (`SUSPICIOUS_ACTIVITY_REPORTED` on that business date), which is also how the job knows
 * the date is done. `audit.dailyReportEnabled` turns it off. Only the date just finished is
 * reported: after the server was off for days, the older ones stay in the report screen.
 */
@Injectable()
export class SuspiciousActivityJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SuspiciousActivityJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly suspicious: SuspiciousActivityService,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
    @Inject(DAILY_REPORT_OPTIONS) private readonly options: DailyReportOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.checkMs <= 0) return;
    this.timer = setInterval(() => {
      this.runAll().catch((error: unknown) => {
        this.logger.error(`The daily suspicious-activity report failed: ${String(error)}`);
      });
    }, this.options.checkMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Every restaurant on this server, one after the other; a run still going is not doubled. */
  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
      for (const { id } of restaurants) await this.runFor(id);
    } finally {
      this.running = false;
    }
  }

  /** Reports the business date before the current one, unless it is reported or turned off. */
  async runFor(restaurantId: string): Promise<DailyReportOutcome | null> {
    const settings = await this.settings.snapshot(restaurantId);
    if (!settings.get('audit.dailyReportEnabled')) return null;
    const today = await currentBusinessDate(this.prisma, restaurantId, this.clock.now());
    const businessDate = addDays(today, -1);
    if (await this.reported(this.prisma, restaurantId, businessDate)) return null;
    const report = await this.suspicious.report(restaurantId, {
      from: businessDate,
      to: businessDate,
    });
    const flags = report.flags.length;
    const totals = Object.fromEntries(
      report.totals.filter((total) => total.count > 0).map((total) => [total.kind, total.count]),
    );
    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`daily-report:${restaurantId}`}, 0))`;
      if (await this.reported(tx, restaurantId, businessDate)) return null;
      const alert =
        flags === 0
          ? null
          : await this.notifications.raise(tx, {
              restaurantId,
              type: 'SUSPICIOUS_ACTIVITY',
              dedupeKey: `suspicious:${businessDate}`,
              payload: { businessDate, flags, totals },
            });
      await this.audit.record(tx, {
        action: REPORTED,
        entityType: 'report',
        entityId: null,
        restaurantId,
        businessDate,
        before: null,
        after: {
          businessDate,
          flags,
          totals,
          people: report.people.map((person) => ({ staffId: person.id, flags: person.count })),
          alertId: alert?.alertId ?? null,
        },
        reason: null,
      });
      return { businessDate, flags, alertId: alert?.alertId ?? null };
    });
  }

  private async reported(
    client: PrismaService | TransactionClient,
    restaurantId: string,
    businessDate: string,
  ): Promise<boolean> {
    const entry = await client.auditLog.findFirst({
      where: { restaurantId, action: REPORTED, businessDate: new Date(businessDate) },
      select: { id: true },
    });
    return entry !== null;
  }
}
