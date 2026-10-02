import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  CONTROL_PLANE_ERRORS,
  MenuDraft,
  type MenuExtractionRequest,
  type MenuExtractionView,
} from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedInstallation } from '../auth/installation.guard.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { MenuExtraction } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { ExtractionError, MENU_EXTRACTOR, type MenuExtractor } from './menu-extractor.js';

/** Menus read at the same time by one Control Plane instance. */
const CONCURRENCY = 2;
/** A busy provider is tried this many times in all, this far apart. */
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 30_000;
/** Drafts are kept this long for the restaurant to come back to, then purged. */
const DRAFT_DAYS = 30;
/** Retries and the purge are looked at this often. */
const TICK_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * AI-assisted menu import (P6-04a, ONB-006, VCP-008). A restaurant's server sends photos or PDFs
 * of its printed menu; they wait in the database while a worker has the AI provider read them
 * (the key is the Control Plane's alone, SEC-002), then are deleted. The draft that comes back is
 * kept for 30 days for the restaurant to fetch; a person checks every dish before anything is
 * imported (P6-04b). Each restaurant may read `CP_AI_DAILY_LIMIT` menus a day (the vendor pays
 * per menu). Jobs survive a restart: one cut off while running is queued again.
 */
@Injectable()
export class MenuExtractionsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MenuExtractionsService.name);
  private running = 0;
  private stopped = false;
  private ticks = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Work in flight, so shutdown waits for it. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(MENU_EXTRACTOR) private readonly extractor: MenuExtractor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Cut off by a restart: read it again.
    await this.prisma.menuExtraction.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'QUEUED' },
    });
    this.kick();
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  async create(
    installation: AuthenticatedInstallation,
    request: MenuExtractionRequest,
  ): Promise<MenuExtractionView> {
    if (!this.extractor.configured) {
      throw new CpError(
        503,
        CONTROL_PLANE_ERRORS.aiImportUnavailable,
        'Reading menus from photos is not available yet. Use the Excel template instead.',
      );
    }
    const since = new Date(Date.now() - DAY_MS);
    const today = await this.prisma.menuExtraction.count({
      where: { tenantId: installation.tenantId, createdAt: { gte: since } },
    });
    if (today >= this.config.aiDailyLimit) {
      throw new CpError(
        429,
        CONTROL_PLANE_ERRORS.aiImportLimit,
        `This restaurant has read ${String(this.config.aiDailyLimit)} menus today. Try again tomorrow.`,
      );
    }
    const files = request.files.map((file, position) => ({
      id: newId(),
      position,
      name: file.name,
      contentType: file.contentType,
      content: Buffer.from(file.contentBase64, 'base64'),
    }));
    const bytes = files.reduce((total, file) => total + file.content.length, 0);
    const id = newId();
    const created = await this.prisma.transaction(async (tx) => {
      const row = await tx.menuExtraction.create({
        data: {
          id,
          tenantId: installation.tenantId,
          installationId: installation.id,
          files: files.length,
          bytes,
          uploads: { create: files },
        },
      });
      await this.audit.record(tx, {
        actor: `installation:${installation.id}`,
        action: 'menu_extraction.requested',
        targetType: 'menu_extraction',
        targetId: id,
        details: { files: files.length, bytes, tenantId: installation.tenantId },
      });
      return row;
    });
    this.kick();
    return this.view(created);
  }

  async get(installation: AuthenticatedInstallation, id: string): Promise<MenuExtractionView> {
    const row = await this.prisma.menuExtraction.findFirst({
      where: { id, tenantId: installation.tenantId },
    });
    if (row === null) {
      throw new CpError(
        404,
        CONTROL_PLANE_ERRORS.menuExtractionNotFound,
        'There is no such menu reading for this restaurant.',
      );
    }
    return this.view(row);
  }

  /** Waits until nothing is queued or running (tests). */
  async settled(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = await this.prisma.menuExtraction.count({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (busy === 0 && this.running === 0) return;
      if (Date.now() > deadline) throw new Error('Menu readings did not settle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Starts workers, up to the concurrency; each reads queued menus until none is left. */
  kick(): void {
    while (!this.stopped && this.running < CONCURRENCY) {
      this.running += 1;
      const work = this.drain()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Menu reading worker failed');
        })
        .finally(() => {
          this.running -= 1;
          this.inFlight.delete(work);
        });
      this.inFlight.add(work);
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped && (await this.next())) {
      // Keep reading while there is work.
    }
  }

  /** Every minute: retries that are due, anything a race left queued; every hour, the purge. */
  private tick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.ticks += 1;
      this.kick();
      if (this.ticks % 60 === 0) void this.purge();
      this.tick();
    }, TICK_MS);
    this.timer.unref();
  }

  /** Claims and reads one queued menu; false when there is none. */
  private async next(): Promise<boolean> {
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE menu_extractions
      SET status = 'RUNNING', started_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM menu_extractions
        WHERE status = 'QUEUED' AND (not_before IS NULL OR not_before <= now())
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text`;
    const id = claimed[0]?.id;
    if (id === undefined) return false;
    const job = await this.prisma.menuExtraction.findUniqueOrThrow({
      where: { id },
      include: { uploads: { orderBy: { position: 'asc' } } },
    });
    try {
      const output = await this.extractor.extract(
        job.uploads.map((file) => ({
          name: file.name,
          contentType: file.contentType,
          content: file.content,
        })),
      );
      await this.finish(job, {
        status: 'DONE',
        draft: output.draft,
        model: output.model,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
      });
    } catch (error) {
      const failure =
        error instanceof ExtractionError
          ? error
          : new ExtractionError('AI_PROVIDER_FAILED', 'The menu could not be read.', true);
      if (failure.retryable && job.attempts < MAX_ATTEMPTS) {
        await this.prisma.menuExtraction.update({
          where: { id },
          data: { status: 'QUEUED', notBefore: new Date(Date.now() + RETRY_AFTER_MS) },
        });
        this.logger.warn({ extractionId: id, attempt: job.attempts }, 'Menu reading will retry');
      } else {
        await this.finish(job, {
          status: 'FAILED',
          errorCode: failure.code,
          errorMessage: failure.message,
        });
      }
    }
    return true;
  }

  private async finish(
    job: MenuExtraction,
    result:
      | {
          status: 'DONE';
          draft: MenuDraft;
          model: string;
          inputTokens: number | null;
          outputTokens: number | null;
        }
      | { status: 'FAILED'; errorCode: string; errorMessage: string },
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await tx.menuExtraction.update({
        where: { id: job.id },
        data: { ...result, finishedAt: new Date() },
      });
      // The photos are not kept once read (data minimisation).
      await tx.menuExtractionFile.deleteMany({ where: { extractionId: job.id } });
      await this.audit.record(tx, {
        actor: 'system:menu-reader',
        action: result.status === 'DONE' ? 'menu_extraction.read' : 'menu_extraction.failed',
        targetType: 'menu_extraction',
        targetId: job.id,
        details:
          result.status === 'DONE'
            ? {
                model: result.model,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                dishes: result.draft.categories.reduce((total, c) => total + c.items.length, 0),
              }
            : { errorCode: result.errorCode },
      });
    });
  }

  /** Drafts older than 30 days are dropped; the job's record stays for the costs. */
  private async purge(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE menu_extractions SET draft = NULL, updated_at = now()
        WHERE draft IS NOT NULL AND finished_at < now() - make_interval(days => ${DRAFT_DAYS})`;
    } catch (error) {
      this.logger.warn({ err: error }, 'Old menu drafts could not be purged');
    }
  }

  private view(row: MenuExtraction): MenuExtractionView {
    return {
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      error:
        row.errorCode === null
          ? null
          : { code: row.errorCode, message: row.errorMessage ?? 'The menu could not be read.' },
      draft: row.draft === null ? null : MenuDraft.parse(row.draft),
    };
  }
}
