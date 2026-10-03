import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { LicenceView } from '@rp/contracts';
import {
  type HeartbeatRequest,
  type HeartbeatResponse,
  SignedLicence,
  type TamperEvent,
} from '@rp/contracts/control-plane';
import {
  addDays,
  type BusinessDayConfig,
  businessDayStart,
  DEFAULT_BUSINESS_DAY,
  type LicenseCapabilities,
} from '@rp/domain';
import {
  clockSkewed,
  evaluateLicence,
  fingerprintOf,
  guardedNow,
  type LicenceStatus,
  readReactivationCode,
  VENDOR_LICENCE_KEYS,
  verifyLicence,
} from '@rp/licensing';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { open, seal } from '../auth/secret-box.js';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { readEnrolment } from '../cloud/control-plane-state.js';
import { currentBusinessDate } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { appendEvent } from '../events/outbox.js';
import { FINGERPRINT_READER, type FingerprintReader, type Identifiers } from './pc-fingerprint.js';

const FILE_KEY = 'licence.file';
const RECORD_KEY = 'licence.record';
const SECRET_KEY = 'licence.reactivation_secret';
/** How often the licence is judged again, so a restriction applies at the business day's start. */
const CHECK_EVERY_MS = 60_000;
/** Hardware rarely changes: the fingerprint is read again every few hours. */
const FINGERPRINT_EVERY_MS = 6 * 60 * 60 * 1_000;
/** Reactivation codes a person may try in an hour (LIC-006: 56-bit codes, so a few is plenty). */
const ATTEMPTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** Device types a licence limits (LIC-001). */
const LIMITED = ['TABLE_TABLET', 'PAGER', 'WAITER_PHONE', 'KDS'] as const;
type Limited = (typeof LIMITED)[number];

/** What the agent keeps between checks, sealed so it cannot be edited unnoticed (LIC-007). */
const LicenceRecord = z.object({
  lastSeenAt: z.iso.datetime(),
  restrictionDecidedAt: z.iso.datetime().nullable(),
  /** An offline reactivation in force (LIC-006): its day and when it ends. */
  reactivation: z.object({ validUntil: z.iso.date(), until: z.iso.datetime() }).nullable(),
  /** The last reactivation code's counter: an older or the same code is refused. */
  lastCounter: z.int().min(0).max(255),
  /** Reactivation tries in the last hour. */
  attempts: z.array(z.iso.datetime()).max(50),
  /** Tamper events not yet delivered to the Control Plane. */
  tamper: z
    .array(
      z.object({
        kind: z.enum([
          'CLOCK_ROLLBACK',
          'CLOCK_SKEW',
          'LICENCE_TAMPERED',
          'RECORD_TAMPERED',
          'OTHER_PC',
        ]),
        at: z.iso.datetime(),
      }),
    )
    .max(20),
  /** When each kind was last delivered: the same kind is reported once a day at most. */
  reported: z.record(z.string(), z.iso.datetime()),
});
type LicenceRecord = z.infer<typeof LicenceRecord>;

export type GatedCapability = keyof Pick<
  LicenseCapabilities,
  'openNewTableSessions' | 'createOrders' | 'sendKots'
>;

/**
 * The local licence agent (LIC-002 to LIC-007): keeps the licence file the Control Plane sends,
 * judges it at start-up and every minute against this PC and the time, and says what the
 * restaurant can do. A restriction applies only from the start of the next business day after it
 * was first decided; bills, printing, reports, exports and backups always work. Its own record
 * (last time seen, the restriction, a reactivation) is sealed, the clock never goes back for it,
 * and anything that looks like tampering is reported in the next heartbeat. In development and
 * tests it shows the licence without restricting unless `RP_LICENCE_ENFORCE` is on.
 */
@Injectable()
export class LicenceAgentService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LicenceAgentService.name);
  private status: LicenceStatus | undefined;
  private identifiers: { readonly at: number; readonly value: Identifiers } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly checkListeners = new Set<() => Promise<unknown>>();
  /** One check at a time: the record is read, judged and written as a whole. */
  private running: Promise<LicenceStatus> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(FINGERPRINT_READER) private readonly reader: FingerprintReader,
  ) {}

  onApplicationBootstrap(): void {
    void this.refresh().catch((error: unknown) => {
      this.logger.error({ err: error }, 'The licence could not be checked');
    });
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logger.error({ err: error }, 'The licence could not be checked');
      });
    }, CHECK_EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    // A check under way finishes before the database closes; otherwise its write reconnects
    // after shutdown and holds a connection (a restore then finds the database in use).
    await this.running?.catch(() => undefined);
  }

  get enforced(): boolean {
    return this.config.licenceEnforce;
  }

  /**
   * Refuses what a restricted licence does not allow (LIC-005): new tables, orders and kitchen
   * tickets. Never anything that finishes, bills or reports what already happened.
   */
  async assert(capability: GatedCapability): Promise<void> {
    if (!this.enforced) return;
    const status = this.status ?? (await this.refresh());
    if (status.capabilities[capability]) return;
    throw new AppError(
      423,
      'LICENCE_RESTRICTED',
      status.recorded === 'TERMINATED'
        ? 'The subscription has ended: new tables and orders are off. Bills, reports and exports still work.'
        : 'The licence is restricted: new tables and orders are paused until the vendor reactivates it. Bills, printing, reports and exports still work.',
      { state: status.recorded, problem: status.problem },
    );
  }

  /** How many devices of a type the licence allows, or null when it sets no limit (LIC-001). */
  async limitFor(type: string): Promise<number | null> {
    if (!this.enforced || !(LIMITED as readonly string[]).includes(type)) return null;
    const status = this.status ?? (await this.refresh());
    return status.payload?.deviceLimits[type as Limited] ?? null;
  }

  /** The licence as `GET /licence` answers it (LIC-008): details only for LICENSE_VIEW. */
  async view(details: boolean): Promise<LicenceView> {
    const status = this.status ?? (await this.refresh());
    const record = (await this.readRecord()).record;
    return {
      state: status.state,
      recorded: status.recorded,
      problem: status.problem,
      restrictedFrom: status.restrictedFrom?.toISOString() ?? null,
      daysLeft: status.daysLeft,
      validUntil: status.validUntil?.toISOString() ?? null,
      enforced: this.enforced,
      capabilities: status.capabilities,
      details: details
        ? {
            installationId: (await readEnrolment(this.prisma))?.installationId ?? null,
            plan: status.payload?.plan ?? null,
            modules: status.payload?.modules ?? [],
            deviceLimits: status.payload?.deviceLimits ?? null,
            deviceCounts: await this.deviceCounts(),
            reason: status.payload?.reason ?? null,
            issuedAt: status.payload?.issuedAt ?? null,
            reactivatedUntil: record?.reactivation?.until ?? null,
          }
        : null,
    };
  }

  /** What a heartbeat reports about the licence (LIC-002, LIC-004, LIC-007). */
  async heartbeatReport(): Promise<Pick<HeartbeatRequest, 'licence' | 'tamper'>> {
    const enrolment = await readEnrolment(this.prisma);
    const file = await this.readFile();
    const verified = verifyLicence(file, this.vendorKeys());
    const { record } = await this.readRecord();
    return {
      licence: {
        licenceId: verified.ok ? verified.payload.licenceId : null,
        fingerprint: await this.fingerprintOf(enrolment?.installationId ?? ''),
        hasReactivationSecret: (await this.reactivationSecret()) !== undefined,
      },
      ...(record !== undefined && record.tamper.length > 0 && { tamper: record.tamper }),
    };
  }

  /**
   * Takes a heartbeat's answer: a new licence (kept only when it verifies for this installation),
   * the reactivation secret, the Control Plane's clock; the tamper events sent are delivered.
   */
  async accept(answer: HeartbeatResponse, reported: readonly TamperEvent[] = []): Promise<void> {
    const enrolment = await readEnrolment(this.prisma);
    if (answer.licence !== null) {
      const verified = verifyLicence(answer.licence, this.vendorKeys());
      if (verified.ok && verified.payload.installationId === enrolment?.installationId) {
        await this.write(FILE_KEY, JSON.stringify(answer.licence));
      } else {
        this.logger.warn('The Control Plane sent a licence this PC does not accept');
      }
    }
    if (answer.reactivationSecret !== null) {
      const key = await this.secrets.get('licence-record-key');
      await this.write(SECRET_KEY, seal(key, Buffer.from(answer.reactivationSecret, 'base64')));
    }
    const skewed = clockSkewed(new Date(), new Date(answer.serverTime));
    await this.update((record) => ({
      ...record,
      tamper: [
        ...record.tamper.filter(
          (event) => !reported.some((sent) => sent.kind === event.kind && sent.at === event.at),
        ),
        ...(skewed ? [{ kind: 'CLOCK_SKEW' as const, at: new Date().toISOString() }] : []),
      ].slice(-20),
      reported: {
        ...record.reported,
        ...Object.fromEntries(reported.map((event) => [event.kind, event.at])),
      },
    }));
    await this.refresh();
  }

  /**
   * An offline reactivation code the vendor read out (LIC-006): for this installation, newer than
   * the last one used, its day not past. A few tries an hour. Audited.
   */
  async reactivate(principal: Principal, code: string, now = new Date()): Promise<LicenceView> {
    const enrolment = await readEnrolment(this.prisma);
    const secret = await this.reactivationSecret();
    const { record } = await this.readRecord();
    const recent = (record?.attempts ?? []).filter(
      (at) => now.getTime() - Date.parse(at) < HOUR_MS,
    );
    if (recent.length >= ATTEMPTS_PER_HOUR) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many codes tried. Try again in an hour.');
    }
    await this.update((current) => ({ ...current, attempts: [...recent, now.toISOString()] }));
    if (enrolment === undefined || secret === undefined) {
      throw new AppError(
        409,
        'REACTIVATION_UNAVAILABLE',
        'This PC has not been connected to the vendor yet, so it cannot take a code.',
      );
    }
    const read = readReactivationCode(code, secret, enrolment.installationId);
    if (read === undefined) {
      throw new AppError(409, 'REACTIVATION_CODE_INVALID', 'That code is not right for this PC.');
    }
    // Older codes are refused, by this PC's record and by the last licence (LIC-006).
    const status = this.status ?? (await this.refresh(now));
    if (
      read.counter <= Math.max(record?.lastCounter ?? 0, status.payload?.reactivationCounter ?? 0)
    ) {
      throw new AppError(409, 'REACTIVATION_CODE_USED', 'That code was already used.');
    }
    const businessDay = await this.businessDay();
    // Active until the end of the code's business day: the next day's cut-off.
    const until = businessDayStart(addDays(read.validUntil, 1), businessDay);
    if (until <= now) {
      throw new AppError(409, 'REACTIVATION_CODE_EXPIRED', 'That code’s day is over.');
    }
    await this.update((current) => ({
      ...current,
      lastCounter: read.counter,
      reactivation: { validUntil: read.validUntil, until: until.toISOString() },
      restrictionDecidedAt: null,
    }));
    await this.prisma.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: 'LICENCE_REACTIVATED',
        entityType: 'licence',
        entityId: enrolment.installationId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: null,
        after: { validUntil: read.validUntil, counter: read.counter },
        reason: null,
      });
    });
    await this.refresh(now);
    return this.view(true);
  }

  /** `POST /licence/check`: a heartbeat now (the Owner has just paid), then the licence. */
  async check(): Promise<LicenceView> {
    for (const listener of this.checkListeners) await listener();
    await this.refresh();
    return this.view(true);
  }

  /** The heartbeat registers how to send one at once. */
  onCheckRequested(listener: () => Promise<unknown>): void {
    this.checkListeners.add(listener);
  }

  /** Judges the licence again now; saves the record; tells every screen when the state changes. */
  refresh(now = new Date()): Promise<LicenceStatus> {
    const run = (this.running ?? Promise.resolve(undefined as LicenceStatus | undefined))
      .catch(() => undefined)
      .then(() => this.evaluate(now));
    this.running = run;
    return run;
  }

  private async evaluate(clock: Date): Promise<LicenceStatus> {
    const enrolment = await readEnrolment(this.prisma);
    const file = await this.readFile();
    const verified = verifyLicence(file, this.vendorKeys());
    const { record, tampered } = await this.readRecord();
    const installationId = enrolment?.installationId ?? '';
    const guard = guardedNow(clock, record === undefined ? undefined : new Date(record.lastSeenAt));
    const status = evaluateLicence({
      file: verified,
      installationId,
      fingerprint: await this.fingerprintOf(installationId),
      now: guard.now,
      // An edited record cannot postpone a restriction: it applies at once.
      restrictionDecidedAt: tampered
        ? new Date(0)
        : record?.restrictionDecidedAt === null || record === undefined
          ? undefined
          : new Date(record.restrictionDecidedAt),
      reactivatedUntil:
        record?.reactivation === null || record === undefined
          ? undefined
          : new Date(record.reactivation.until),
      businessDay: await this.businessDay(),
    });
    const events: TamperEvent[] = [];
    const at = guard.now.toISOString();
    if (guard.rolledBack) events.push({ kind: 'CLOCK_ROLLBACK', at });
    if (tampered) events.push({ kind: 'RECORD_TAMPERED', at });
    if (file !== undefined && !verified.ok) events.push({ kind: 'LICENCE_TAMPERED', at });
    if (status.problem === 'OTHER_PC') events.push({ kind: 'OTHER_PC', at });
    await this.update(
      (current) => ({
        ...current,
        lastSeenAt: at,
        restrictionDecidedAt: status.restrictionDecidedAt?.toISOString() ?? null,
        reactivation:
          current.reactivation !== null &&
          Date.parse(current.reactivation.until) > guard.now.getTime()
            ? current.reactivation
            : null,
        // The same kind is reported once a day, so a stuck clock does not flood the Control Plane.
        tamper: [
          ...current.tamper,
          ...events.filter((event) => {
            const last = [
              ...current.tamper
                .filter((known) => known.kind === event.kind)
                .map((known) => known.at),
              ...(current.reported[event.kind] === undefined ? [] : [current.reported[event.kind]]),
            ];
            return !last.some(
              (at) => at !== undefined && Math.abs(guard.now.getTime() - Date.parse(at)) < DAY_MS,
            );
          }),
        ].slice(-20),
      }),
      tampered,
    );
    const previous = this.status;
    this.status = status;
    if (
      previous !== undefined &&
      (previous.state !== status.state ||
        previous.recorded !== status.recorded ||
        previous.restrictedFrom?.getTime() !== status.restrictedFrom?.getTime())
    ) {
      await this.announce(status);
    } else if (previous === undefined && status.state !== 'ACTIVE') {
      this.logger.warn(
        { state: status.state, recorded: status.recorded, problem: status.problem },
        'The licence is not active',
      );
    }
    return status;
  }

  /** Every screen reads the licence again; the change is audited (LIC-005: logged locally). */
  private async announce(status: LicenceStatus): Promise<void> {
    this.logger.warn(
      { state: status.state, recorded: status.recorded, problem: status.problem },
      'The licence state changed',
    );
    const restaurant = await this.prisma.restaurant.findFirst({ select: { id: true } });
    if (restaurant === null) return;
    await this.prisma.transaction(async (tx) => {
      const businessDate = await currentBusinessDate(tx, restaurant.id);
      await this.audit.record(tx, {
        action: 'LICENCE_STATE_CHANGED',
        entityType: 'licence',
        entityId: restaurant.id,
        actorId: null,
        deviceId: null,
        restaurantId: restaurant.id,
        before: null,
        after: {
          state: status.state,
          recorded: status.recorded,
          problem: status.problem,
          restrictedFrom: status.restrictedFrom?.toISOString() ?? null,
        },
        reason: null,
      });
      await appendEvent(
        tx,
        {
          eventId: newId(),
          version: 1,
          occurredAt: new Date().toISOString(),
          restaurantId: restaurant.id,
          businessDate,
          type: 'LicenceChanged',
          payload: {
            state: status.state,
            restrictedFrom: status.restrictedFrom?.toISOString() ?? null,
          },
        },
        { aggregate: { type: 'licence', id: restaurant.id } },
      );
    });
  }

  private vendorKeys(): readonly string[] {
    return [...VENDOR_LICENCE_KEYS, ...this.config.licenceKeys];
  }

  /** The fingerprint for this installation; the identifiers are read again every few hours. */
  private async fingerprintOf(installationId: string): Promise<(string | null)[]> {
    const cached = this.identifiers;
    if (cached !== undefined && Date.now() - cached.at < FINGERPRINT_EVERY_MS) {
      return fingerprintOf(installationId, cached.value);
    }
    let identifiers: Identifiers = {};
    try {
      identifiers = await this.reader.read();
    } catch (error) {
      this.logger.warn({ err: error }, 'The PC fingerprint could not be read');
    }
    this.identifiers = { at: Date.now(), value: identifiers };
    return fingerprintOf(installationId, identifiers);
  }

  private async businessDay(): Promise<BusinessDayConfig> {
    const restaurant = await this.prisma.restaurant.findFirst({
      select: { timeZone: true, businessDayCutoff: true },
    });
    return restaurant === null
      ? DEFAULT_BUSINESS_DAY
      : { timeZone: restaurant.timeZone, cutoff: restaurant.businessDayCutoff };
  }

  private async deviceCounts(): Promise<Record<string, number>> {
    const groups = await this.prisma.device.groupBy({
      by: ['type'],
      where: { status: 'ACTIVE', type: { in: [...LIMITED] } },
      _count: { _all: true },
    });
    return Object.fromEntries(
      LIMITED.map((type) => [type, groups.find((group) => group.type === type)?._count._all ?? 0]),
    );
  }

  private async readFile(): Promise<SignedLicence | undefined> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: FILE_KEY } });
    if (row === null) return undefined;
    try {
      const parsed = SignedLicence.safeParse(JSON.parse(row.value));
      // A file that does not even read as one is a file tampered with.
      return parsed.success
        ? parsed.data
        : { payload: '{}', signature: 'AA==', keyId: '0'.repeat(16) };
    } catch {
      return { payload: '{}', signature: 'AA==', keyId: '0'.repeat(16) };
    }
  }

  private async reactivationSecret(): Promise<Buffer | undefined> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: SECRET_KEY } });
    if (row === null) return undefined;
    try {
      return open(await this.secrets.get('licence-record-key'), row.value);
    } catch {
      return undefined;
    }
  }

  /**
   * The sealed record, or undefined on a first start. `tampered` when it is there but does not
   * open or read, or is missing while a licence is kept: someone edited the database.
   */
  private async readRecord(): Promise<{ record: LicenceRecord | undefined; tampered: boolean }> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: RECORD_KEY } });
    if (row === null) {
      const file = await this.prisma.systemMeta.findUnique({ where: { key: FILE_KEY } });
      return { record: undefined, tampered: file !== null };
    }
    try {
      const text = open(await this.secrets.get('licence-record-key'), row.value).toString('utf8');
      const parsed = LicenceRecord.safeParse(JSON.parse(text));
      return parsed.success
        ? { record: parsed.data, tampered: false }
        : { record: undefined, tampered: true };
    } catch {
      return { record: undefined, tampered: true };
    }
  }

  private async update(
    change: (record: LicenceRecord) => LicenceRecord,
    tampered = false,
  ): Promise<void> {
    const { record } = await this.readRecord();
    const base: LicenceRecord = record ?? {
      lastSeenAt: new Date().toISOString(),
      restrictionDecidedAt: tampered ? new Date(0).toISOString() : null,
      reactivation: null,
      lastCounter: 0,
      attempts: [],
      tamper: [],
      reported: {},
    };
    const next = LicenceRecord.parse(change(base));
    const key = await this.secrets.get('licence-record-key');
    await this.write(RECORD_KEY, seal(key, Buffer.from(JSON.stringify(next), 'utf8')));
  }

  private async write(key: string, value: string): Promise<void> {
    await this.prisma.systemMeta.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}
