import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { retentionCutoffs } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { saveRetentionRun } from './retention-state.js';

export const RETENTION_OPTIONS = Symbol('RETENTION_OPTIONS');

export interface RetentionOptions {
  readonly firstDelayMs: number;
  /** How often the retention runs; 0 never by itself (tests). */
  readonly everyMs: number;
  readonly now: () => Date;
}

export const DEFAULT_RETENTION_OPTIONS: RetentionOptions = {
  firstDelayMs: 10 * 60_000,
  everyMs: 24 * 60 * 60_000,
  now: () => new Date(),
};

const DAY_MS = 24 * 60 * 60_000;
/** A restore or recovery's work folder left by a crash is removed after a day. */
const WORK_FOLDER = /^\.(restore|pitr)-/;

export interface RetentionResult {
  readonly alerts: number;
  readonly serviceRequests: number;
  readonly printNotices: number;
  readonly idempotencyRecords: number;
  readonly dinerContactsAnonymised: number;
  readonly feedbackAnonymised: number;
  readonly files: number;
}

/**
 * The automatic retention of BRD §9.3 (DATA-007, DATA-011, P7-06a), once a day:
 *
 * - operational data older than `retention.operationalDays` (90): cleared or acknowledged alerts,
 *   closed service requests, print notices, expired idempotency records, the server's log files,
 *   and downloaded or leftover restore files. (The event outbox and photos have their own.)
 * - a diner's phone number after `retention.dinerContactMonths` (24) without a visit, and
 *   feedback comments and their link to a diner after `retention.feedbackMonths` (24): the
 *   ratings stay for the reports, without anything that identifies a person.
 *
 * Orders, bills, payments and the audit log are never touched here: only archive-then-purge
 * removes them (DATA-008, P7-06b). Each run that changes anything is audited with its counts.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private current: Promise<RetentionResult> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RETENTION_OPTIONS) private readonly options: RetentionOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.everyMs > 0) this.schedule(this.options.firstDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  /** Applies the retention now. One run at a time. */
  run(): Promise<RetentionResult> {
    const work = (this.current ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(() => this.apply(this.options.now()));
    this.current = work;
    return work;
  }

  private async apply(now: Date): Promise<RetentionResult> {
    const totals = {
      alerts: 0,
      serviceRequests: 0,
      printNotices: 0,
      idempotencyRecords: 0,
      dinerContactsAnonymised: 0,
      feedbackAnonymised: 0,
      files: 0,
    };
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    let shortestDays: number | undefined;
    for (const { id: restaurantId } of restaurants) {
      const settings = await this.settings.snapshot(restaurantId);
      const days = settings.get('retention.operationalDays');
      shortestDays = Math.min(shortestDays ?? days, days);
      const {
        operationalBefore: before,
        dinerContactsBefore: contactsBefore,
        feedbackBefore,
      } = retentionCutoffs(now, {
        operationalDays: days,
        dinerContactMonths: settings.get('retention.dinerContactMonths'),
        feedbackMonths: settings.get('retention.feedbackMonths'),
      });
      const counts = await this.prisma.transaction(async (tx) => {
        const serviceRequests = await tx.serviceRequest.deleteMany({
          where: { restaurantId, closedAt: { not: null, lt: before } },
        });
        // An alert a service request still points at stays with it.
        const alerts = await tx.$executeRaw`
          DELETE FROM alerts a
          WHERE a.restaurant_id = ${restaurantId}::uuid AND a.status <> 'OPEN'
            AND a.updated_at < ${before}
            AND NOT EXISTS (SELECT 1 FROM service_requests s WHERE s.alert_id = a.id)`;
        const printNotices = await tx.printNotice.deleteMany({
          where: { restaurantId, createdAt: { lt: before }, printStatus: { not: 'PENDING' } },
        });
        const idempotencyRecords = await tx.idempotencyRecord.deleteMany({
          where: { restaurantId, expiresAt: { lt: before } },
        });
        // The last visit (`lastVisitOf` in @rp/domain): the consent, or the latest feedback.
        const stale = await tx.$queryRaw<{ id: string }[]>`
          SELECT c.id FROM diner_contacts c
          WHERE c.restaurant_id = ${restaurantId}::uuid AND c.erased_at IS NULL
            AND GREATEST(c.consent_given_at,
                  COALESCE((SELECT MAX(f.created_at) FROM feedback f
                            WHERE f.diner_contact_id = c.id), c.consent_given_at))
                < ${contactsBefore}`;
        const contacts = await tx.dinerContact.updateMany({
          where: { id: { in: stale.map((row) => row.id) } },
          data: { phone: null, erasedAt: now },
        });
        const feedback = await tx.feedback.updateMany({
          where: {
            restaurantId,
            createdAt: { lt: feedbackBefore },
            OR: [{ comment: { not: null } }, { dinerContactId: { not: null } }],
          },
          data: { comment: null, dinerContactId: null },
        });
        const result = {
          alerts,
          serviceRequests: serviceRequests.count,
          printNotices: printNotices.count,
          idempotencyRecords: idempotencyRecords.count,
          dinerContactsAnonymised: contacts.count,
          feedbackAnonymised: feedback.count,
        };
        if (Object.values(result).some((count) => count > 0)) {
          await this.audit.record(tx, {
            action: 'RETENTION_APPLIED',
            entityType: 'restaurant',
            entityId: restaurantId,
            restaurantId,
            after: result,
            reason: 'Automatic retention (BRD §9.3)',
          });
        }
        return result;
      });
      for (const [key, value] of Object.entries(counts)) {
        totals[key as keyof typeof counts] += value;
      }
    }
    totals.files = await this.removeFiles(now, shortestDays ?? 90);
    await saveRetentionRun(this.prisma, {
      at: now.toISOString(),
      total: Object.values(totals).reduce((sum, count) => sum + count, 0),
    });
    return totals;
  }

  /** Log files past the operational period, and restore leftovers. */
  private async removeFiles(now: Date, days: number): Promise<number> {
    const before = now.getTime() - days * DAY_MS;
    let removed = 0;
    const older = async (folder: string, limit: number, match: (name: string) => boolean) => {
      const names = await readdir(folder).catch(() => [] as string[]);
      for (const name of names) {
        if (!match(name)) continue;
        const path = join(folder, name);
        const modified = await stat(path).then(
          (stats) => stats.mtimeMs,
          () => null,
        );
        if (modified !== null && modified < limit) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      }
    };
    await older(join(this.config.dataDir, 'logs'), before, (name) =>
      /\.log(\.\d+)?(\.gz)?$/.test(name),
    );
    await older(join(this.config.dataDir, 'backups', 'cloud'), before, (name) =>
      name.endsWith('.rpbk'),
    );
    await older(this.config.dataDir, now.getTime() - DAY_MS, (name) => WORK_FOLDER.test(name));
    return removed;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.run()
        .then(
          (result) => {
            this.logger.log(result, 'Retention applied');
          },
          (error: unknown) => {
            this.logger.error({ err: error }, 'The retention could not be applied');
          },
        )
        .finally(() => {
          this.schedule(this.options.everyMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
