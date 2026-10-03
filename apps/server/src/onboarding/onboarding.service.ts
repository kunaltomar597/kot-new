import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ActivateResponse,
  GoLiveView,
  OnboardingResponse,
  OnboardingStep,
  OnboardingStepView,
} from '@rp/contracts';
import {
  CONFIRMED_STEPS,
  type GoLivePath,
  goLiveCheck,
  markProblem,
  type OnboardingFacts,
  type OnboardingMark,
  onboardingProgress,
  SKIPPABLE_STEPS,
} from '@rp/domain';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { ControlPlaneError } from '../cloud/control-plane-client.js';
import { readEnrolment } from '../cloud/control-plane-state.js';
import { enrolInstallation, normaliseEnrolmentCode } from '../cloud/enrolment.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';

const MARKS_KEY = 'onboarding.marks';
const GO_LIVE_KEY = 'onboarding.go_live_started_at';
const Marks = z.record(z.string(), z.enum(['DONE', 'SKIPPED']));

const MARK_PROBLEMS = {
  NOT_SKIPPABLE: 'Every restaurant needs this step; it cannot be skipped.',
  NOT_CONFIRMABLE: 'This step is done when its page is set up; there is nothing to confirm.',
  NOT_READY: 'Finish the step first (for the go-live test: every other step).',
} as const;

/**
 * The first-run setup (ONB-004, P7-07a): each step's status from what the restaurant has set up
 * and what a person confirmed or skipped, so it resumes wherever it stopped; and activating the
 * PC with the vendor's code (ONB-003).
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    private readonly prisma: PrismaService,
    private readonly heartbeat: HeartbeatService,
    private readonly audit: AuditService,
  ) {}

  async view(restaurantId: string): Promise<OnboardingResponse> {
    const [facts, marks, enrolment] = await Promise.all([
      this.facts(restaurantId),
      this.marks(),
      readEnrolment(this.prisma),
    ]);
    const progress = onboardingProgress(facts, marks);
    return {
      steps: progress.steps.map((entry): OnboardingStepView => ({
        ...entry,
        confirmable: CONFIRMED_STEPS.includes(entry.step),
        skippable: SKIPPABLE_STEPS.includes(entry.step),
      })),
      complete: progress.complete,
      activation: {
        configured: this.config.controlPlaneUrl !== undefined,
        activated: enrolment !== undefined,
        installationName: enrolment?.name ?? null,
      },
    };
  }

  /** Confirms or skips a step, or takes the mark back; audited. */
  async mark(
    principal: Principal,
    step: OnboardingStep,
    status: OnboardingMark | 'TODO',
  ): Promise<OnboardingResponse> {
    const marks = await this.marks();
    if (status !== 'TODO') {
      const progress = onboardingProgress(await this.facts(principal.restaurantId), marks);
      const problem = markProblem(step, status, progress);
      if (problem !== null) throw new AppError(409, problem, MARK_PROBLEMS[problem]);
    }
    const next: Partial<Record<OnboardingStep, OnboardingMark>> = Object.fromEntries(
      Object.entries(marks).filter(([key]) => key !== step),
    );
    if (status !== 'TODO') next[step] = status;
    await this.prisma.transaction(async (tx) => {
      const value = JSON.stringify(next);
      await tx.systemMeta.upsert({
        where: { key: MARKS_KEY },
        create: { key: MARKS_KEY, value },
        update: { value },
      });
      await this.audit.record(tx, {
        action: 'ONBOARDING_STEP_MARKED',
        entityType: 'onboarding',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { step, mark: marks[step] ?? null },
        after: { step, mark: status === 'TODO' ? null : status },
      });
    });
    return this.view(principal.restaurantId);
  }

  /** Activates this PC with the vendor's one-time code (ONB-003), then reports at once. */
  async activate(principal: Principal, code: string): Promise<ActivateResponse> {
    if (this.config.controlPlaneUrl === undefined) {
      throw new AppError(
        409,
        'CONTROL_PLANE_NOT_CONFIGURED',
        'This PC does not know the vendor’s address yet. Ask the installer or support.',
      );
    }
    if ((await readEnrolment(this.prisma)) !== undefined) {
      throw new AppError(409, 'ALREADY_ACTIVATED', 'This PC is already activated.');
    }
    try {
      normaliseEnrolmentCode(code);
    } catch (error) {
      throw new AppError(422, 'ACTIVATION_CODE_INVALID', (error as Error).message);
    }
    let enrolment;
    try {
      enrolment = await enrolInstallation({
        config: this.config,
        prisma: this.prisma,
        secrets: this.secrets,
        code,
        logger: this.logger,
        actor: { staffId: principal.staffId, deviceId: principal.deviceId },
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status !== undefined && error.status < 500) {
        throw new AppError(422, 'ACTIVATION_CODE_INVALID', error.message, { code: error.code });
      }
      if (error instanceof ControlPlaneError) {
        throw new AppError(
          503,
          'CONTROL_PLANE_UNREACHABLE',
          'The vendor could not be reached. Check the internet connection and try again.',
        );
      }
      throw error;
    }
    // The licence comes with the first heartbeat (LIC-001); do not keep the Owner waiting for it.
    void this.heartbeat.beat();
    return { installationId: enrolment.installationId, installationName: enrolment.name };
  }

  private async marks(): Promise<Partial<Record<OnboardingStep, OnboardingMark>>> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: MARKS_KEY } });
    if (row === null) return {};
    try {
      const parsed = Marks.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  /**
   * The guided go-live test (ONB-004 step 11, P7-07c): since it started, has the server seen an
   * order from each place the restaurant takes them, a kitchen screen working one, a pager
   * acknowledging an alert, and a bill paid?
   */
  async goLive(restaurantId: string): Promise<GoLiveView> {
    const [startedRow, marks, devices, tablesWithQr] = await Promise.all([
      this.prisma.systemMeta.findUnique({ where: { key: GO_LIVE_KEY } }),
      this.marks(),
      this.prisma.device.findMany({
        where: { restaurantId, status: 'ACTIVE' },
        select: { id: true, type: true },
      }),
      this.prisma.diningTable.count({
        where: { restaurantId, archivedAt: null, qrToken: { not: null } },
      }),
    ]);
    const startedAt = startedRow === null ? null : startedRow.value;
    const has = (type: string) => devices.some((device) => device.type === type);
    const use = {
      waiterPhones: has('WAITER_PHONE'),
      tablets: has('TABLE_TABLET'),
      qr: marks.QR !== 'SKIPPED' && tablesWithQr > 0,
      kitchenScreens: has('KDS'),
      pagers: has('PAGER'),
    };
    if (startedAt === null) return goLiveCheck(null, use, {});
    const since = new Date(startedAt);
    const firstOrder = (source: 'POS' | 'WAITER_APP' | 'TABLE_TABLET' | 'QR') =>
      this.prisma.order
        .findFirst({
          where: { restaurantId, source, createdAt: { gte: since } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
        .then((row) => row?.createdAt);
    const kds = devices.filter((device) => device.type === 'KDS').map((device) => device.id);
    const [pos, waiter, tablet, qr, kitchen, pager, bill] = await Promise.all([
      firstOrder('POS'),
      firstOrder('WAITER_APP'),
      firstOrder('TABLE_TABLET'),
      firstOrder('QR'),
      this.prisma.orderEvent
        .findFirst({
          where: { restaurantId, deviceId: { in: kds }, occurredAt: { gte: since } },
          orderBy: { occurredAt: 'asc' },
          select: { occurredAt: true },
        })
        .then((row) => row?.occurredAt),
      this.prisma.alert
        .findFirst({
          where: { restaurantId, channels: { has: 'PAGER' }, acknowledgedAt: { gte: since } },
          orderBy: { acknowledgedAt: 'asc' },
          select: { acknowledgedAt: true },
        })
        .then((row) => row?.acknowledgedAt ?? undefined),
      this.prisma.payment
        .findFirst({
          where: { restaurantId, status: 'CAPTURED', createdAt: { gte: since } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
        .then((row) => row?.createdAt),
    ]);
    const seen: Partial<Record<GoLivePath, string>> = {};
    const entries: [GoLivePath, Date | undefined][] = [
      ['POS_ORDER', pos],
      ['WAITER_APP', waiter],
      ['TABLE_TABLET', tablet],
      ['QR', qr],
      ['KDS', kitchen],
      ['PAGER', pager],
      ['BILL', bill],
    ];
    for (const [path, at] of entries) if (at !== undefined) seen[path] = at.toISOString();
    return goLiveCheck(startedAt, use, seen);
  }

  /** Starts the go-live test again from now: only what happens next counts. Audited. */
  async startGoLive(principal: Principal): Promise<GoLiveView> {
    const now = new Date().toISOString();
    await this.prisma.transaction(async (tx) => {
      await tx.systemMeta.upsert({
        where: { key: GO_LIVE_KEY },
        create: { key: GO_LIVE_KEY, value: now },
        update: { value: now },
      });
      await this.audit.record(tx, {
        action: 'GO_LIVE_TEST_STARTED',
        entityType: 'onboarding',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { startedAt: now },
      });
    });
    return this.goLive(principal.restaurantId);
  }

  /** What the restaurant has, counted (ONB-004). */
  async facts(restaurantId: string): Promise<OnboardingFacts> {
    const live = { restaurantId, archivedAt: null };
    const activeStaff = { restaurantId, active: true, archivedAt: null };
    const [
      restaurant,
      taxGroups,
      defaultSeries,
      owners,
      managers,
      tables,
      stations,
      menuItems,
      menuVersions,
      staffWithPins,
      pairedDevices,
      tablesWithoutQr,
    ] = await Promise.all([
      this.prisma.restaurant.findUnique({ where: { id: restaurantId } }),
      this.prisma.taxGroup.count({ where: live }),
      this.prisma.invoiceSeries.count({ where: { ...live, isDefault: true } }),
      this.prisma.staff.findMany({
        where: { ...activeStaff, role: { baseRole: 'OWNER' } },
        select: { credentials: { select: { kind: true, confirmedAt: true } } },
      }),
      this.prisma.staff.count({ where: { ...activeStaff, role: { baseRole: 'MANAGER' } } }),
      this.prisma.diningTable.count({ where: live }),
      this.prisma.station.findMany({
        where: live,
        select: { mode: true, printer: { select: { lastSeenAt: true, archivedAt: true } } },
      }),
      this.prisma.item.count({ where: live }),
      this.prisma.menuVersion.count({ where: { restaurantId } }),
      this.prisma.staff.count({
        where: {
          ...activeStaff,
          role: { baseRole: { in: ['CASHIER', 'WAITER', 'KITCHEN'] } },
          credentials: { some: { kind: 'PIN' } },
        },
      }),
      this.prisma.device.count({
        where: { restaurantId, status: 'ACTIVE', type: { notIn: ['POS', 'MANAGER_BROWSER'] } },
      }),
      this.prisma.diningTable.count({ where: { ...live, qrToken: null } }),
    ]);
    const goLive = await this.goLive(restaurantId);
    const hours = restaurant?.businessHours;
    return {
      profileComplete:
        typeof restaurant?.legalName === 'string' &&
        restaurant.address !== null &&
        restaurant.stateCode !== null &&
        Array.isArray(hours) &&
        hours.length > 0,
      taxGroups,
      defaultInvoiceSeries: defaultSeries > 0,
      ownerHasSecondFactor: owners.some(
        (owner) =>
          owner.credentials.some((credential) => credential.kind === 'PASSWORD') &&
          owner.credentials.some(
            (credential) => credential.kind === 'TOTP' && credential.confirmedAt !== null,
          ),
      ),
      managers,
      tables,
      stations: stations.length,
      stationsWithoutWorkingPrinter: stations.filter(
        (station) =>
          station.mode !== 'SCREEN' &&
          (station.printer?.archivedAt !== null || station.printer.lastSeenAt === null),
      ).length,
      menuItems,
      menuPublished: menuVersions > 0,
      staffWithPins,
      pairedDevices,
      tablesWithoutQr,
      goLivePassed: goLive.passed,
    };
  }
}
