import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DeviceLimits,
  type HeartbeatRequest,
  LICENCE_MODULES,
  type LicenceModule,
  type LicencePayload,
  type LicenceState,
  type SignedLicence,
} from '@rp/contracts/control-plane';
import { canTransition, LICENSE_EVENTS, licenseMachine, transition } from '@rp/domain';
import { isLicensedPc, reactivationCode, reactivationSecretOf } from '@rp/licensing';
import type { AuthenticatedInstallation } from '../auth/installation.guard.js';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import { type InstallationLicence, type LicenceFile, Prisma } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { LicenceSigner } from './licence-signer.js';

const DAY_MS = 86_400_000;
/** A licence is renewed at least daily while the installation is online (LIC-002). */
const RENEW_AFTER_MS = DAY_MS;
/** Device limits a new installation starts with, until the vendor sets its plan (P7-02). */
const DEFAULT_LIMITS: DeviceLimits = { TABLE_TABLET: 30, PAGER: 15, WAITER_PHONE: 15, KDS: 6 };
/** How far ahead an offline reactivation code may reach. */
const REACTIVATION_MAX_DAYS = 60;

type Report = NonNullable<HeartbeatRequest['licence']>;
type Fingerprint = (string | null)[];

export interface HeartbeatLicence {
  readonly licence: SignedLicence | null;
  readonly reactivationSecret: string | null;
  /** Heartbeats asked while the licence is not active; null for the fleet's interval. */
  readonly heartbeatSeconds: number | null;
}

export interface LicenceChange {
  readonly state?: LicenceState;
  readonly plan?: string;
  readonly modules?: readonly LicenceModule[];
  readonly deviceLimits?: DeviceLimits;
  readonly validityDays?: number;
  readonly graceDays?: number;
  /** Why, for the Owner and the audit trail; required. */
  readonly reason: string;
}

export interface LicenceSummary {
  readonly installationId: string;
  readonly plan: string;
  readonly modules: readonly string[];
  readonly deviceLimits: DeviceLimits;
  readonly state: LicenceState;
  readonly reason: string | null;
  readonly graceStartedAt: Date | null;
  readonly validityDays: number;
  readonly graceDays: number;
  readonly boundAt: Date | null;
  readonly revision: number;
  readonly latest: { id: string; issuedAt: Date; validUntil: Date; state: LicenceState } | null;
}

function fingerprintOf(terms: InstallationLicence): Fingerprint | null {
  const value = terms.fingerprint;
  return Array.isArray(value) &&
    value.length === 5 &&
    value.every((entry) => entry === null || typeof entry === 'string')
    ? value
    : null;
}

function limitsOf(terms: InstallationLicence): DeviceLimits {
  const parsed = DeviceLimits.safeParse(terms.deviceLimits);
  return parsed.success ? parsed.data : DEFAULT_LIMITS;
}

function asSigned(file: LicenceFile): SignedLicence {
  return { payload: file.payload, signature: file.signature, keyId: file.keyId };
}

function notFound(): CpError {
  return new CpError(404, 'NOT_FOUND', 'The installation was not found.');
}

/**
 * Licences (LIC-001 to LIC-006, VCP-003): each installation's terms, and the signed files issued
 * from them in heartbeat answers. A file is renewed daily while online and at once when the
 * terms change; the PC fingerprint is bound at the first licence and follows small hardware
 * changes; an installation whose licence is not active is asked to beat every minute, so a
 * payment recorded reactivates it within a minute. Vendor changes are audited with a reason.
 */
@Injectable()
export class LicencesService {
  private readonly logger = new Logger(LicencesService.name);

  constructor(
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly signer: LicenceSigner,
  ) {}

  /** What a heartbeat answer carries about the licence. */
  async forHeartbeat(
    installation: AuthenticatedInstallation,
    report: Report | undefined,
    now = new Date(),
  ): Promise<HeartbeatLicence> {
    const reactivationSecret =
      report !== undefined && !report.hasReactivationSecret
        ? (this.secretOf(installation.id)?.toString('base64') ?? null)
        : null;
    if (!this.signer.ready || report === undefined) {
      return { licence: null, reactivationSecret, heartbeatSeconds: null };
    }
    return this.prisma.transaction(async (tx) => {
      const terms = await this.lockedTerms(tx, installation.id);
      const heartbeatSeconds =
        terms.state === 'ACTIVE' ? null : this.config.licenceHeartbeatSeconds;
      const bound = fingerprintOf(terms);
      let fingerprint = bound;
      if (bound === null) {
        fingerprint = report.fingerprint;
        await tx.installationLicence.update({
          where: { installationId: installation.id },
          data: { fingerprint: report.fingerprint, boundAt: now },
        });
        await this.audit.record(tx, {
          actor: `installation:${installation.id}`,
          action: 'licence.bound',
          targetType: 'installation',
          targetId: installation.id,
        });
      } else if (!isLicensedPc(bound, report.fingerprint)) {
        // Another PC: no licence until support re-binds it (LIC-004).
        this.logger.warn({ installationId: installation.id }, 'Licence asked from another PC');
        return { licence: null, reactivationSecret, heartbeatSeconds };
      } else if (JSON.stringify(bound) !== JSON.stringify(report.fingerprint)) {
        // Still the same PC with a part changed: the licence follows it.
        fingerprint = report.fingerprint;
        await tx.installationLicence.update({
          where: { installationId: installation.id },
          data: { fingerprint: report.fingerprint },
        });
      }
      const latest = await tx.licenceFile.findFirst({
        where: { installationId: installation.id },
        orderBy: { issuedAt: 'desc' },
      });
      const current =
        latest !== null &&
        latest.revision === terms.revision &&
        fingerprint === bound &&
        now.getTime() - latest.issuedAt.getTime() < RENEW_AFTER_MS;
      if (current) {
        return {
          licence: report.licenceId === latest.id ? null : asSigned(latest),
          reactivationSecret,
          heartbeatSeconds,
        };
      }
      const licence = await this.issue(
        tx,
        installation,
        terms,
        fingerprint ?? report.fingerprint,
        now,
      );
      return { licence, reactivationSecret, heartbeatSeconds };
    });
  }

  /** The terms and the latest file, for vendor staff. */
  async summary(installationId: string): Promise<LicenceSummary> {
    const terms = await this.prisma.transaction((tx) => this.lockedTerms(tx, installationId));
    const latest = await this.prisma.licenceFile.findFirst({
      where: { installationId },
      orderBy: { issuedAt: 'desc' },
    });
    return {
      installationId,
      plan: terms.plan,
      modules: terms.modules,
      deviceLimits: limitsOf(terms),
      state: terms.state,
      reason: terms.reason,
      graceStartedAt: terms.graceStartedAt,
      validityDays: terms.validityDays,
      graceDays: terms.graceDays,
      boundAt: terms.boundAt,
      revision: terms.revision,
      latest:
        latest === null
          ? null
          : {
              id: latest.id,
              issuedAt: latest.issuedAt,
              validUntil: latest.validUntil,
              state: latest.state,
            },
    };
  }

  /**
   * Changes an installation's terms (VCP-003): its state along LIC-005 (never out of TERMINATED),
   * plan, modules, device limits or days. The next heartbeat carries a new licence.
   */
  async change(
    installationId: string,
    change: LicenceChange,
    actor: string,
    now = new Date(),
  ): Promise<LicenceSummary> {
    const reason = change.reason.trim();
    if (reason.length < 3 || reason.length > 200) {
      throw new CpError(400, 'VALIDATION_FAILED', 'Give a reason of 3 to 200 characters.');
    }
    if (change.deviceLimits !== undefined) DeviceLimits.parse(change.deviceLimits);
    await this.prisma.transaction(async (tx) => {
      const terms = await this.lockedTerms(tx, installationId);
      const target = change.state ?? terms.state;
      if (target !== terms.state) {
        const event = LICENSE_EVENTS.find(
          (candidate) =>
            canTransition(licenseMachine, terms.state, candidate) &&
            transition(licenseMachine, terms.state, candidate).to === target,
        );
        if (event === undefined) {
          throw new CpError(
            409,
            'LICENCE_STATE_CHANGE_NOT_ALLOWED',
            `A licence cannot go from ${terms.state} to ${target}.`,
          );
        }
      }
      const data = {
        state: target,
        reason,
        graceStartedAt:
          target === 'GRACE' ? (terms.state === 'GRACE' ? terms.graceStartedAt : now) : null,
        ...(change.plan !== undefined && { plan: change.plan.trim() }),
        ...(change.modules !== undefined && { modules: [...change.modules] }),
        ...(change.deviceLimits !== undefined && { deviceLimits: { ...change.deviceLimits } }),
        ...(change.validityDays !== undefined && { validityDays: change.validityDays }),
        ...(change.graceDays !== undefined && { graceDays: change.graceDays }),
        revision: terms.revision + 1,
      };
      await tx.installationLicence.update({ where: { installationId }, data });
      await this.audit.record(tx, {
        actor,
        action: 'licence.changed',
        targetType: 'installation',
        targetId: installationId,
        details: {
          reason,
          before: {
            state: terms.state,
            plan: terms.plan,
            deviceLimits: limitsOf(terms),
            validityDays: terms.validityDays,
            graceDays: terms.graceDays,
          },
          after: {
            state: target,
            plan: data.plan ?? terms.plan,
            deviceLimits: change.deviceLimits ?? limitsOf(terms),
            validityDays: data.validityDays ?? terms.validityDays,
            graceDays: data.graceDays ?? terms.graceDays,
          },
        },
      });
    });
    return this.summary(installationId);
  }

  /** Support moves the licence to a new PC (LIC-004): the next licence binds the PC asking. */
  async rebind(installationId: string, reason: string, actor: string): Promise<LicenceSummary> {
    if (reason.trim().length < 3) {
      throw new CpError(400, 'VALIDATION_FAILED', 'Give a reason of 3 to 200 characters.');
    }
    await this.prisma.transaction(async (tx) => {
      const terms = await this.lockedTerms(tx, installationId);
      await tx.installationLicence.update({
        where: { installationId },
        data: { fingerprint: Prisma.DbNull, boundAt: null, revision: terms.revision + 1 },
      });
      await this.audit.record(tx, {
        actor,
        action: 'licence.rebound',
        targetType: 'installation',
        targetId: installationId,
        details: { reason: reason.trim(), boundAt: terms.boundAt?.toISOString() ?? null },
      });
    });
    return this.summary(installationId);
  }

  /**
   * An offline reactivation code (LIC-006), read to the Owner over the phone: active until
   * `until` (YYYY-MM-DD). The code is shown once and never stored; the audit keeps its day and
   * counter.
   */
  async reactivationCode(
    installationId: string,
    until: string,
    actor: string,
    now = new Date(),
  ): Promise<{ code: string; validUntil: string; counter: number }> {
    const secret = this.secretOf(installationId);
    if (secret === undefined) {
      throw new CpError(
        409,
        'REACTIVATION_UNAVAILABLE',
        'No reactivation master key is configured (CP_LICENCE_REACTIVATION_KEY).',
      );
    }
    const today = now.toISOString().slice(0, 10);
    const last = new Date(now.getTime() + REACTIVATION_MAX_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < today || until > last) {
      throw new CpError(
        400,
        'VALIDATION_FAILED',
        `Choose a day from ${today} to ${last} (at most ${String(REACTIVATION_MAX_DAYS)} days ahead).`,
      );
    }
    return this.prisma.transaction(async (tx) => {
      const terms = await this.lockedTerms(tx, installationId);
      if (terms.state === 'TERMINATED') {
        throw new CpError(409, 'LICENCE_TERMINATED', 'The contract has ended.');
      }
      const counter = terms.reactivationCounter + 1;
      if (counter > 255) {
        throw new CpError(409, 'REACTIVATION_EXHAUSTED', 'No more codes: re-issue the secret.');
      }
      await tx.installationLicence.update({
        where: { installationId },
        data: { reactivationCounter: counter },
      });
      await this.audit.record(tx, {
        actor,
        action: 'licence.reactivation_code',
        targetType: 'installation',
        targetId: installationId,
        details: { validUntil: until, counter },
      });
      return {
        code: reactivationCode(secret, installationId, until, counter),
        validUntil: until,
        counter,
      };
    });
  }

  private secretOf(installationId: string): Buffer | undefined {
    const master = this.config.licenceReactivationKey;
    return master === undefined
      ? undefined
      : reactivationSecretOf(Buffer.from(master, 'base64'), installationId);
  }

  /** The installation's terms, locked; created with the defaults the first time. */
  private async lockedTerms(
    tx: TransactionClient,
    installationId: string,
  ): Promise<InstallationLicence> {
    const installation = await tx.installation.findUnique({ where: { id: installationId } });
    if (installation === null) throw notFound();
    await tx.installationLicence.createMany({
      data: [
        {
          installationId,
          plan: 'Standard',
          modules: [...LICENCE_MODULES],
          deviceLimits: { ...DEFAULT_LIMITS },
          validityDays: this.config.licenceValidityDays,
          graceDays: this.config.licenceGraceDays,
        },
      ],
      skipDuplicates: true,
    });
    await tx.$queryRaw`SELECT 1 AS locked FROM installation_licences WHERE installation_id = ${installationId}::uuid FOR UPDATE`;
    return tx.installationLicence.findUniqueOrThrow({ where: { installationId } });
  }

  private async issue(
    tx: TransactionClient,
    installation: AuthenticatedInstallation,
    terms: InstallationLicence,
    fingerprint: Fingerprint,
    now: Date,
  ): Promise<SignedLicence> {
    const payload: LicencePayload = {
      format: 1,
      licenceId: newId(),
      tenantId: installation.tenantId,
      installationId: installation.id,
      fingerprint,
      plan: terms.plan,
      modules: terms.modules.filter((module): module is LicenceModule =>
        (LICENCE_MODULES as readonly string[]).includes(module),
      ),
      deviceLimits: limitsOf(terms),
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + terms.validityDays * DAY_MS).toISOString(),
      graceDays: terms.graceDays,
      state: terms.state,
      graceStartedAt: terms.graceStartedAt?.toISOString() ?? null,
      reason: terms.reason,
    };
    const signed = this.signer.sign(payload);
    await tx.licenceFile.create({
      data: {
        id: payload.licenceId,
        installationId: installation.id,
        revision: terms.revision,
        state: terms.state,
        issuedAt: now,
        validUntil: new Date(payload.validUntil),
        payload: signed.payload,
        signature: signed.signature,
        keyId: signed.keyId,
      },
    });
    return signed;
  }
}
