import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { UpdateAgentStatus, UpdateWait } from '@rp/contracts';
import type { ReleaseInfo, UpdateReport } from '@rp/contracts/control-plane';
import {
  DEFAULT_TIME_ZONE,
  isNewerVersion,
  updateDownloadRetryMs,
  updateTiming,
  type UpdateTiming,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { BackupService } from '../backups/backup.service.js';
import { readOfferedUpdate } from '../cloud/control-plane-state.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { newId } from '../common/ids.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { programDataDir } from '../installation/installation.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { SettingsService } from '../settings/settings.service.js';
import { readInstallApproval } from '../system/system-state.js';
import {
  installerVersionProblem,
  judgeSignature,
  powerShellSignatureCheck,
  type SignatureCheck,
  type SignaturePolicy,
  signaturePolicyProblem,
} from './authenticode.js';
import { downloadInstaller, installerMatches } from './update-download.js';
import {
  installerFileName,
  readUpdateOutcome,
  readUpdateRequest,
  removeUpdateRequest,
  updatesDir,
  writeUpdateRequest,
} from './update-files.js';
import {
  type AgentDownload,
  type AgentOutcome,
  type AgentState,
  readAgentState,
  saveAgentState,
  saveUpdateReport,
} from './update-state.js';

export const UPDATE_AGENT_OPTIONS = Symbol('UPDATE_AGENT_OPTIONS');

export interface UpdateAgentOptions {
  /** Wait after start-up before the first look (let the server settle). */
  readonly firstDelayMs: number;
  /** How often it looks; 0 never schedules (tests call `runOnce`). */
  readonly tickMs: number;
  /** After the backup or integrity check before an update failed. */
  readonly prepareRetryMs: number;
  /** A request the watchdog has not taken this long: the updater never started. */
  readonly pickupTimeoutMs: number;
  /** No outcome this long after the hand-off: the updater stopped without one. */
  readonly handoffTimeoutMs: number;
  /** Authenticode; null where Windows cannot check it (off Windows: the updater checks it). */
  readonly signatureCheck: SignatureCheck | null;
  /** `%ProgramData%\RestaurantPlatform`, where the updater writes its outcome. */
  readonly programDataDir: string;
  readonly fetch?: typeof fetch;
  readonly now: () => Date;
}

export const DEFAULT_UPDATE_AGENT_OPTIONS: UpdateAgentOptions = {
  firstDelayMs: 60_000,
  tickMs: 60_000,
  prepareRetryMs: 30 * 60_000,
  pickupTimeoutMs: 10 * 60_000,
  // The updater's maintenance flag lasts at most four hours.
  handoffTimeoutMs: 5 * 60 * 60_000,
  signatureCheck: process.platform === 'win32' ? powerShellSignatureCheck() : null,
  programDataDir: programDataDir(),
  now: () => new Date(),
};

type Live = Omit<UpdateAgentStatus, 'lastOutcome'>;

const IDLE: Live = { state: 'IDLE', version: null, waitingFor: null, error: null, retryAt: null };

/** A message for people: what went wrong, on one line. */
function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 480);
}

/**
 * The update agent on the restaurant PC (UPD-004, UPD-005, UPD-007, P7-04c). Every minute:
 *
 * 1. the updater's outcome for a hand-off, recorded, audited and reported to the vendor;
 * 2. the release the Control Plane offers (P0-17b), when newer than this PC's version, downloaded
 *    in the background over HTTPS and checked: size, SHA-256, Authenticode;
 * 3. `updateTiming`: the maintenance window or a manager's "Install now", never with open tables
 *    unless security-critical and approved;
 * 4. a full backup, checked end to end, and no migration left half done;
 * 5. the hand-off: INSTALLING reported, then the request the watchdog passes to the updater, which
 *    copies the database, runs the installer, checks the new version's health and rolls back the
 *    application and the database when it fails.
 */
@Injectable()
export class UpdateAgentService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UpdateAgentService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly aborter = new AbortController();
  private live: Live = IDLE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly backups: BackupService,
    private readonly heartbeat: HeartbeatService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UPDATE_AGENT_OPTIONS) private readonly options: UpdateAgentOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.tickMs <= 0) return;
    // A new offer arrives with a heartbeat's answer: look at once.
    this.heartbeat.onAnswer(async () => {
      this.soon();
      return Promise.resolve();
    });
    this.schedule(this.options.firstDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.aborter.abort();
    await this.running;
  }

  /** Looks again shortly (after "Install now", or a new offer). */
  soon(): void {
    if (this.options.tickMs > 0) this.schedule(1_000);
  }

  /** One look and whatever it calls for (the schedule calls it; so do tests). Never throws. */
  runOnce(): Promise<void> {
    this.running ??= this.tick()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'The update agent failed');
        this.live = { ...this.live, error: plainError(error) };
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** For the System page. */
  async status(): Promise<UpdateAgentStatus> {
    const state = await readAgentState(this.prisma);
    const live: Live =
      state.handoff === null
        ? this.live
        : { ...IDLE, state: 'INSTALLING', version: state.handoff.version };
    const last = state.lastOutcome;
    return {
      ...live,
      lastOutcome:
        last === null
          ? null
          : {
              version: last.version,
              previousVersion: last.previousVersion,
              outcome: last.outcome,
              at: last.at,
              error: last.error,
              backupFileName: last.backupFileName,
            },
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (!this.stopped) this.schedule(this.options.tickMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const now = this.options.now();
    const dataDir = this.config.dataDir;
    let state = await readAgentState(this.prisma);

    // 1. The updater's outcome.
    if (state.handoff !== null) {
      const handoff = state.handoff;
      const seen = await readUpdateOutcome(this.options.programDataDir);
      const outcome = seen?.requestId === handoff.requestId ? seen : null;
      const age = now.getTime() - Date.parse(handoff.at);
      if (outcome !== null && outcome.outcome !== 'RUNNING') {
        state = await this.record(state, {
          outcome: outcome.outcome,
          error: outcome.error,
          at: now,
        });
      } else if (
        outcome === null &&
        (await readUpdateRequest(dataDir))?.requestId === handoff.requestId &&
        age > this.options.pickupTimeoutMs
      ) {
        await removeUpdateRequest(dataDir);
        state = await this.record(state, {
          outcome: 'FAILED',
          error:
            'The updater did not start (the watchdog service runs it). Nothing was changed; the update is tried again after "Install now".',
          at: now,
        });
      } else if (age > this.options.handoffTimeoutMs) {
        state = await this.record(state, {
          outcome: 'FAILED',
          error:
            'The updater stopped without saying how the update went. Its log is in ProgramData\\RestaurantPlatform\\setup-logs.',
          at: now,
        });
      } else {
        this.live = { ...IDLE, state: 'INSTALLING', version: handoff.version };
        return;
      }
    }

    // 2. Whether this PC can install updates.
    const installed = this.config.productVersion;
    if (installed === undefined) {
      this.live = {
        ...IDLE,
        state: 'UNAVAILABLE',
        error: 'Updates install on the restaurant PC, where the installer set the version.',
      };
      return;
    }
    const policy: SignaturePolicy = {
      publisher: this.config.updatePublisher ?? null,
      allowUnsigned: this.config.updateAllowUnsigned,
    };
    const problem = signaturePolicyProblem(policy);
    if (problem !== null) {
      this.live = { ...IDLE, state: 'UNAVAILABLE', error: problem };
      return;
    }

    // 3. The release on offer.
    const offered = await readOfferedUpdate(this.prisma);
    if (offered === null || !isNewerVersion(offered.version, installed)) {
      if (state.download !== null || state.preparation !== null) {
        state = { ...state, download: null, preparation: null };
        await saveAgentState(this.prisma, state);
      }
      await this.cleanDownloads(null);
      this.live = IDLE;
      return;
    }

    // 4. The download.
    const fileName = installerFileName(offered.version);
    const target = join(updatesDir(dataDir), fileName);
    let download = state.download;
    if (
      download !== null &&
      (download.version !== offered.version ||
        download.sha256 !== offered.sha256 ||
        download.sizeBytes !== offered.sizeBytes ||
        (download.status === 'READY' && !(await exists(target))))
    ) {
      download = null;
    }
    if (download?.status !== 'READY') {
      const retryAt = download?.retryAt ?? null;
      if (download !== null && retryAt !== null && now.getTime() < Date.parse(retryAt)) {
        this.live = {
          ...IDLE,
          state: 'DOWNLOAD_FAILED',
          version: offered.version,
          error: download.error,
          retryAt: download.retryAt,
        };
        return;
      }
      this.live = { ...IDLE, state: 'DOWNLOADING', version: offered.version };
      // Nothing on disk is the release now: older versions, a re-published file, a partial one.
      await this.cleanDownloads(null);
      download = await this.download(offered, target, download?.failures ?? 0, policy);
      state = { ...state, download };
      await saveAgentState(this.prisma, state);
      if (download.status !== 'READY') {
        this.live = {
          ...IDLE,
          state: 'DOWNLOAD_FAILED',
          version: offered.version,
          error: download.error,
          retryAt: download.retryAt,
        };
        return;
      }
    }

    // 5. When.
    const timing = await this.timing(offered, state, now);
    if (!timing.install) {
      this.live = waiting(offered.version, timing.waitFor);
      return;
    }

    // 6. The backup and the integrity check (UPD-005).
    const preparation = state.preparation;
    if (
      preparation !== null &&
      preparation.version === offered.version &&
      now.getTime() < Date.parse(preparation.retryAt)
    ) {
      this.live = {
        ...IDLE,
        state: 'PREPARE_FAILED',
        version: offered.version,
        error: preparation.error,
        retryAt: preparation.retryAt,
      };
      return;
    }
    this.live = { ...IDLE, state: 'PREPARING', version: offered.version };
    const prepared = await this.prepare(target, download);
    if (!prepared.ok) {
      const retryAt = new Date(
        this.options.now().getTime() + (prepared.retryMs ?? this.options.prepareRetryMs),
      ).toISOString();
      state = {
        ...state,
        download: prepared.downloadAgain ? null : state.download,
        preparation: { version: offered.version, error: prepared.error, retryAt },
      };
      await saveAgentState(this.prisma, state);
      this.logger.warn({ version: offered.version, error: prepared.error }, 'The update waits');
      this.live = {
        ...IDLE,
        state: 'PREPARE_FAILED',
        version: offered.version,
        error: prepared.error,
        retryAt,
      };
      return;
    }
    // The backup took a while: tables may have opened, or the window closed.
    const now2 = this.options.now();
    const still = await this.timing(offered, state, now2);
    if (!still.install) {
      this.live = waiting(offered.version, still.waitFor);
      return;
    }

    // 7. The hand-off.
    await this.handOff(state, {
      offered,
      download,
      trigger: still.trigger,
      installed,
      backupFileName: prepared.backupFileName,
      now: now2,
    });
  }

  private async timing(offered: ReleaseInfo, state: AgentState, now: Date): Promise<UpdateTiming> {
    const restaurant = await this.prisma.restaurant.findFirst({
      select: { id: true, timeZone: true },
    });
    const window =
      restaurant === null
        ? { start: '03:00', end: '06:00' }
        : (await this.settings.snapshot(restaurant.id)).get('updates.maintenanceWindow');
    const [approval, openTables] = await Promise.all([
      readInstallApproval(this.prisma),
      this.prisma.tableSession.count({ where: { status: 'OPEN' } }),
    ]);
    const last = state.lastOutcome;
    return updateTiming({
      now,
      timeZone: restaurant?.timeZone ?? DEFAULT_TIME_ZONE,
      window,
      release: { version: offered.version, securityCritical: offered.securityCritical },
      approval:
        approval === null
          ? null
          : { version: approval.version, approvedAt: new Date(approval.approvedAt) },
      openTables,
      lastFailure:
        last === null || last.outcome === 'INSTALLED'
          ? null
          : { version: last.version, at: new Date(last.at) },
    });
  }

  private async download(
    offered: ReleaseInfo,
    target: string,
    failures: number,
    policy: SignaturePolicy,
  ): Promise<AgentDownload> {
    const base = {
      version: offered.version,
      fileName: installerFileName(offered.version),
      sha256: offered.sha256,
      sizeBytes: offered.sizeBytes,
    };
    this.logger.log({ version: offered.version }, 'Downloading the update');
    try {
      await mkdir(updatesDir(this.config.dataDir), { recursive: true });
      await downloadInstaller({
        url: offered.url,
        sha256: offered.sha256,
        sizeBytes: offered.sizeBytes,
        target,
        signal: this.aborter.signal,
        ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
      });
      let signer: string | null = null;
      if (this.options.signatureCheck !== null) {
        const seen = await this.options.signatureCheck(target);
        const verdict = judgeSignature(seen, policy);
        const problem = verdict.ok
          ? installerVersionProblem(seen, offered.version)
          : verdict.reason;
        if (problem !== null) {
          await rm(target, { force: true });
          throw new Error(problem);
        }
        signer = verdict.ok ? verdict.signer : null;
      }
      this.logger.log({ version: offered.version, signer }, 'The update is downloaded and checked');
      return { ...base, status: 'READY', error: null, failures: 0, retryAt: null, signer };
    } catch (error) {
      const count = failures + 1;
      const retryAt = new Date(this.options.now().getTime() + updateDownloadRetryMs(count));
      this.logger.warn({ err: error, version: offered.version }, 'The update download failed');
      return {
        ...base,
        status: 'FAILED',
        error: plainError(error),
        failures: count,
        retryAt: retryAt.toISOString(),
        signer: null,
      };
    }
  }

  /** The full backup, checked, and the integrity check before the hand-off (UPD-005). */
  private async prepare(
    target: string,
    download: AgentDownload,
  ): Promise<
    | { readonly ok: true; readonly backupFileName: string | null }
    | {
        readonly ok: false;
        readonly error: string;
        readonly retryMs?: number;
        readonly downloadAgain?: boolean;
      }
  > {
    if (!(await installerMatches(target, download))) {
      return {
        ok: false,
        error: 'The downloaded installer changed since it was checked; it is downloaded again.',
        retryMs: 0,
        downloadAgain: true,
      };
    }
    const halfDone = await this.halfDoneMigrations();
    if (halfDone.length > 0) {
      return {
        ok: false,
        error: `Migration ${halfDone.join(', ')} was left half done; the database needs support before it can be updated.`,
      };
    }
    let run;
    try {
      run = await this.backups.backUpForUpdate();
    } catch (error) {
      if (error instanceof AppError && error.code === 'BACKUP_RUNNING') {
        return {
          ok: false,
          error: 'Another backup is running; the update waits for it.',
          retryMs: 5 * 60_000,
        };
      }
      throw error;
    }
    if (run.status === 'FAILED' || run.fileName === null) {
      return {
        ok: false,
        error: `The backup before the update failed: ${run.error ?? 'no detail'}`,
      };
    }
    return { ok: true, backupFileName: run.fileName };
  }

  private async halfDoneMigrations(): Promise<string[]> {
    const [table] = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
    if (table?.present !== true) return [];
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT migration_name AS name FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
    return rows.map((row) => row.name);
  }

  private async handOff(
    state: AgentState,
    input: {
      readonly offered: ReleaseInfo;
      readonly download: AgentDownload;
      readonly trigger: 'WINDOW' | 'APPROVED';
      readonly installed: string;
      readonly backupFileName: string | null;
      readonly now: Date;
    },
  ): Promise<void> {
    const { offered, download, trigger, installed, backupFileName, now } = input;
    const approval = trigger === 'APPROVED' ? await readInstallApproval(this.prisma) : null;
    const requestId = newId();
    const handoff = {
      requestId,
      version: offered.version,
      previousVersion: installed,
      at: now.toISOString(),
      backupFileName,
    };
    const report: UpdateReport = {
      version: offered.version,
      outcome: 'INSTALLING',
      at: now.toISOString(),
      error: null,
    };
    await this.prisma.transaction(async (tx) => {
      await saveAgentState(tx, { ...state, preparation: null, handoff });
      await saveUpdateReport(tx, report);
      await this.audit.record(tx, {
        action: 'UPDATE_STARTED',
        entityType: 'software_update',
        entityId: null,
        actorId: approval?.approvedByStaffId ?? null,
        after: {
          version: offered.version,
          previousVersion: installed,
          channel: offered.channel,
          securityCritical: offered.securityCritical,
          trigger,
          backupFileName,
          signer: download.signer,
        },
        reason: trigger === 'APPROVED' ? 'Install now' : 'Maintenance window',
      });
    });
    this.live = { ...IDLE, state: 'INSTALLING', version: offered.version };
    this.logger.warn(
      { version: offered.version, previousVersion: installed, trigger },
      'Handing the update to the updater; the server restarts',
    );
    // The vendor hears INSTALLING before the services stop.
    await this.heartbeat.beat();
    try {
      await writeUpdateRequest(this.config.dataDir, {
        format: 1,
        requestId,
        version: offered.version,
        previousVersion: installed,
        fileName: download.fileName,
        sha256: download.sha256,
        sizeBytes: download.sizeBytes,
        securityCritical: offered.securityCritical,
        trigger,
        approvedByStaffId: approval?.approvedByStaffId ?? null,
        backupFileName,
        requestedAt: now.toISOString(),
      });
    } catch (error) {
      await this.record(await readAgentState(this.prisma), {
        outcome: 'FAILED',
        error: `The update could not be handed to the updater: ${plainError(error)}`,
        at: this.options.now(),
      });
      this.live = IDLE;
    }
  }

  /** Records how the update ended: the agent's state, the report for the vendor and the audit. */
  private async record(
    state: AgentState,
    result: {
      readonly outcome: AgentOutcome['outcome'];
      readonly error: string | null;
      readonly at: Date;
    },
  ): Promise<AgentState> {
    const handoff = state.handoff;
    if (handoff === null) return state;
    const lastOutcome: AgentOutcome = {
      requestId: handoff.requestId,
      version: handoff.version,
      previousVersion: handoff.previousVersion,
      outcome: result.outcome,
      at: result.at.toISOString(),
      error: result.error,
      backupFileName: handoff.backupFileName,
    };
    // A request left behind is never started again (the updater removes it when it starts).
    if ((await readUpdateRequest(this.config.dataDir))?.requestId === handoff.requestId) {
      await removeUpdateRequest(this.config.dataDir);
    }
    const next: AgentState = {
      download: result.outcome === 'INSTALLED' ? null : state.download,
      preparation: null,
      handoff: null,
      lastOutcome,
    };
    await this.prisma.transaction(async (tx) => {
      await saveAgentState(tx, next);
      await saveUpdateReport(tx, {
        version: handoff.version,
        outcome: result.outcome,
        at: lastOutcome.at,
        error: result.error?.slice(0, 300) ?? null,
      });
      await this.audit.record(tx, {
        action: `UPDATE_${result.outcome}`,
        entityType: 'software_update',
        entityId: null,
        after: {
          version: handoff.version,
          previousVersion: handoff.previousVersion,
          backupFileName: handoff.backupFileName,
        },
        reason: result.error,
      });
    });
    if (result.outcome === 'INSTALLED') {
      this.logger.log({ version: handoff.version }, 'The update is installed');
      await this.cleanDownloads(null);
    } else {
      this.logger.error(
        { version: handoff.version, outcome: result.outcome, error: result.error },
        'The update did not install',
      );
    }
    void this.heartbeat.beat();
    return next;
  }

  /** Removes everything in the updates folder but `keep` (old versions, partial downloads). */
  private async cleanDownloads(keep: string | null): Promise<void> {
    const folder = updatesDir(this.config.dataDir);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return;
    }
    for (const name of names) {
      if (name !== keep) await rm(join(folder, name), { force: true, recursive: true });
    }
  }
}

function waiting(version: string, waitFor: UpdateWait): Live {
  return { ...IDLE, state: 'WAITING', version, waitingFor: waitFor };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
