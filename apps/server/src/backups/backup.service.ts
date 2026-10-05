import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  BackupKind,
  BackupRunView,
  BackupsResponse,
  RecoveryKeyResponse,
  RestoreBackupRequest,
  RestoreBackupResponse,
  RestorePointInTimeRequest,
} from '@rp/contracts';
import {
  backupHealth,
  backupsToRemove,
  DEFAULT_TIME_ZONE,
  lastNightlySlot,
  nightlyBackupDue,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { SECRET_NAMES, SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { ServerLifecycle } from '../common/server-lifecycle.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import { PrismaService } from '../database/prisma.service.js';
import type { BackupRun } from '../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { writeArchive } from './backup-archive.js';
import {
  BACKUP_INFO,
  type BackupInfo,
  type BackupSecrets,
  DATABASE_DUMP,
  folderEntries,
  SECRETS,
  verifyBackupFile,
  withManifest,
} from './backup-contents.js';
import { BackupFileError, backupKeyId, encryptBackup, readBackupHeader } from './backup-file.js';
import { backupSummary } from './backup-state.js';
import { CloudBackupService } from './cloud-backup.service.js';
import { ContinuousBackupService } from './continuous-backup.service.js';
import { fullBackupFor, locateRecovery, PointInTimeError } from './point-in-time.js';
import { readRestoreOutcome, readRestoreRequest, saveRestoreRequest } from './pending-restore.js';
import { pgProgram, runPgTool } from './pg-tools.js';
import { formatRecoveryKey } from './recovery-key.js';
import { RESTORE_RECORD_KEY, RestoreRecord } from './restore.js';

export const BACKUP_OPTIONS = Symbol('BACKUP_OPTIONS');

export interface BackupOptions {
  /** Wait after start-up before the first check (let the PC settle). */
  readonly firstDelayMs: number;
  /** How often to check whether the nightly backup is due; 0 never checks (tests). */
  readonly checkEveryMs: number;
  readonly now: () => Date;
}

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  firstDelayMs: 2 * 60_000,
  checkEveryMs: 5 * 60_000,
  now: () => new Date(),
};

/** Backup files: `rp-backup-20261003T043000Z-nightly.rpbk` (also `-manual`, `-update`). */
const FILE_PATTERN = /^rp-backup-(\d{8}T\d{6}Z)-(nightly|manual|update)\.rpbk$/;
/** The folder backups go in, under the data folder and under the second location. */
const FULL_FOLDER = join('backups', 'full');
const SECOND_FOLDER = 'rp-backups';
/** The secret that opens the backups is never inside them (it is escrowed instead, P7-05e). */
const BACKUP_KEY = 'backup-key';
const RUNS_SHOWN = 20;

function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function takenAtOf(name: string): Date | null {
  const s = FILE_PATTERN.exec(name)?.[1];
  if (s === undefined) return null;
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  );
}

/** A message for people: what went wrong, without paths or secrets. */
function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 480);
}

const errors = {
  running: () =>
    new AppError(409, 'BACKUP_RUNNING', 'A backup is running already. Wait for it to finish.'),
  noSecondLocation: () =>
    new AppError(409, 'NO_SECOND_LOCATION', 'No second backup location is set.'),
  notFound: () => new AppError(404, 'BACKUP_NOT_FOUND', 'There is no such backup there.'),
  otherKey: () =>
    new AppError(
      422,
      'BACKUP_KEY_MISMATCH',
      'That backup was made with another backup key. Restore it with the restore tool and the recovery key of the PC that made it.',
    ),
  future: () => new AppError(422, 'POINT_IN_TIME_FUTURE', 'Choose a time that has passed.'),
  pointInTime: (error: PointInTimeError) =>
    new AppError(
      422,
      error.code === 'NO_FULL_BACKUP' ? 'NO_FULL_BACKUP' : 'NO_BASE_BACKUP',
      error.message,
    ),
};

/**
 * Local backups (DATA-002, DATA-005, SEC-007, P7-05a): every night, and on "Back up now", a full
 * backup of the database (`pg_dump`), the photos, the LAN TLS files and the secrets the data needs,
 * encrypted with the backup key, written to the data drive, checked end to end, copied to the
 * second location and checked there. Old backups are removed by the retention (14 daily and 8
 * weekly by default). A failure alerts the Owner and managers, and the heartbeat reports it to the
 * vendor.
 */
@Injectable()
export class BackupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private current: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BACKUP_OPTIONS) private readonly options: BackupOptions,
    private readonly lifecycle: ServerLifecycle,
    private readonly continuous: ContinuousBackupService,
    private readonly cloud: CloudBackupService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // A backup cut off by a crash or power cut never finishes: it failed. The server starts even
    // while the database is down (P0-07); the next start marks it.
    await this.prisma.backupRun
      .updateMany({
        where: { status: 'RUNNING' },
        data: {
          status: 'FAILED',
          finishedAt: this.options.now(),
          error: 'The backup was interrupted (the server stopped).',
        },
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Interrupted backups could not be marked');
      });
    await this.auditRestore().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'The restore could not be audited yet');
    });
    if (this.options.checkEveryMs > 0 && this.config.backups === 'on') {
      this.schedule(this.options.firstDelayMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  /** Waits for the backup in progress, if any (tests, shutdown). */
  async settled(): Promise<void> {
    await this.current?.catch(() => undefined);
  }

  get dataDriveFolder(): string {
    return join(this.config.dataDir, FULL_FOLDER);
  }

  /** The nightly backup, when it is due (DATA-002). Returns the run it started, if any. */
  async runIfDue(): Promise<BackupRun | null> {
    const restaurant = await this.prisma.restaurant.findFirst({ select: { id: true } });
    // Nothing to back up before the first run creates the restaurant (P7-07b).
    if (restaurant === null) return null;
    const settings = await this.settings.snapshot(restaurant.id);
    const [success, attempt] = await Promise.all([
      this.prisma.backupRun.findFirst({
        where: { status: 'SUCCEEDED' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      this.prisma.backupRun.findFirst({
        where: { kind: 'NIGHTLY' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
    ]);
    const due = nightlyBackupDue({
      now: this.options.now(),
      nightlyAt: settings.get('backups.nightlyAt'),
      lastSuccessAt: success?.startedAt ?? null,
      lastAttemptAt: attempt?.startedAt ?? null,
    });
    if (!due) return null;
    return this.start('NIGHTLY').catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'BACKUP_RUNNING') return null;
      throw error;
    });
  }

  /** "Back up now" (DATA-002): starts a full backup in the background. Audited. */
  async backUpNow(principal: Principal): Promise<BackupRunView> {
    const run = await this.start('MANUAL', principal);
    return this.viewOf(run, await this.namesOf([run]));
  }

  /**
   * The full backup before a software update (UPD-005, P7-04c): made and checked end to end like
   * the nightly one, and waited for. Returns the finished run: SUCCEEDED or PARTIAL (checked on
   * the data drive) lets the update go ahead.
   */
  async backUpForUpdate(): Promise<BackupRun> {
    const run = await this.start('UPDATE');
    await this.settled();
    return this.prisma.backupRun.findUniqueOrThrow({ where: { id: run.id } });
  }

  /** Records the run as RUNNING (one at a time) and makes the backup in the background. */
  async start(kind: BackupKind, principal?: Principal): Promise<BackupRun> {
    const run = await this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADVISORY_LOCKS.backupStart})`;
      if ((await tx.backupRun.count({ where: { status: 'RUNNING' } })) > 0) throw errors.running();
      const created = await tx.backupRun.create({
        data: {
          kind,
          status: 'RUNNING',
          startedAt: this.options.now(),
          requestedById: principal?.staffId ?? null,
        },
      });
      if (principal !== undefined) {
        await this.audit.record(tx, {
          action: 'BACKUP_REQUESTED',
          entityType: 'backup_run',
          entityId: created.id,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId: principal.restaurantId,
          reason: 'Back up now',
        });
      }
      return created;
    });
    const work = this.make(run).catch((error: unknown) => {
      this.logger.error({ err: error }, 'The backup could not be recorded');
    });
    this.current = work;
    void work.finally(() => {
      if (this.current === work) this.current = undefined;
    });
    return run;
  }

  /**
   * "Restore" (DATA-004, P7-05b): checks the backup is there and opens with this PC's key, saves
   * the request and restarts the server, which restores before it starts again. The Owner only,
   * with a fresh second factor (the route's DATA_ADMIN); audited with the reason.
   */
  async requestRestore(
    principal: Principal,
    request: RestoreBackupRequest,
  ): Promise<RestoreBackupResponse> {
    const settings = await this.settings.snapshot(principal.restaurantId);
    if ('pointInTime' in request) {
      return this.requestPointInTime(principal, request, settings.get('backups.secondLocation'));
    }
    let folder = this.dataDriveFolder;
    if (request.location === 'SECOND') {
      const second = settings.get('backups.secondLocation');
      if (second === null) throw errors.noSecondLocation();
      folder = join(second, SECOND_FOLDER);
    }
    if (takenAtOf(request.fileName) === null) throw errors.notFound();
    const path = join(folder, request.fileName);
    const header = await readBackupHeader(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw errors.notFound();
      if (error instanceof BackupFileError) throw errors.notFound();
      throw error;
    });
    if (header.keyId !== backupKeyId(await this.secrets.get(BACKUP_KEY))) throw errors.otherKey();
    if ((await this.prisma.backupRun.count({ where: { status: 'RUNNING' } })) > 0) {
      throw errors.running();
    }
    const requestedAt = this.options.now();
    await saveRestoreRequest(this.config.dataDir, {
      path,
      requestedAt: requestedAt.toISOString(),
      requestedBy: { staffId: principal.staffId, deviceId: principal.deviceId },
    });
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'RESTORE_REQUESTED',
        entityType: 'backup',
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: {
          location: request.location,
          fileName: request.fileName,
          backupCreatedAt: header.createdAt,
        },
        reason: request.reason,
      }),
    );
    this.logger.warn({ fileName: request.fileName }, 'Restarting to restore a backup');
    this.lifecycle.requestRestart();
    return {
      requestedAt: requestedAt.toISOString(),
      backupCreatedAt: header.createdAt,
      pointInTime: null,
    };
  }

  /**
   * "Restore to a moment" (DATA-004, P7-05c): checks there is a base backup from before it, made
   * with this PC's key, and a nightly backup for the photos and keys; then as a file restore.
   */
  private async requestPointInTime(
    principal: Principal,
    request: RestorePointInTimeRequest,
    secondLocation: string | null,
  ): Promise<RestoreBackupResponse> {
    const requestedAt = this.options.now();
    const to = request.pointInTime.to === null ? null : new Date(request.pointInTime.to);
    if (to !== null && to.getTime() > requestedAt.getTime()) throw errors.future();
    const second = this.continuous.secondRoot(secondLocation);
    const roots = [this.continuous.dataDriveRoot, ...(second === null ? [] : [second])];
    const fullBackupFolders = [this.dataDriveFolder, ...(second === null ? [] : [second])];
    const key = await this.secrets.get(BACKUP_KEY);
    let located;
    try {
      located = await locateRecovery(roots, to);
      await fullBackupFor(fullBackupFolders, to ?? requestedAt, key);
    } catch (error) {
      if (error instanceof PointInTimeError) throw errors.pointInTime(error);
      throw error;
    }
    const header = await readBackupHeader(located.file);
    if (header.keyId !== backupKeyId(key)) throw errors.otherKey();
    if ((await this.prisma.backupRun.count({ where: { status: 'RUNNING' } })) > 0) {
      throw errors.running();
    }
    await saveRestoreRequest(this.config.dataDir, {
      pointInTime: { to: to?.toISOString() ?? null, roots, fullBackupFolders },
      requestedAt: requestedAt.toISOString(),
      requestedBy: { staffId: principal.staffId, deviceId: principal.deviceId },
    });
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'RESTORE_REQUESTED',
        entityType: 'backup',
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: {
          pointInTime: to?.toISOString() ?? 'LATEST',
          baseBackup: located.base.name,
        },
        reason: request.reason,
      }),
    );
    this.logger.warn({ to: to?.toISOString() ?? 'latest' }, 'Restarting to restore to a moment');
    this.lifecycle.requestRestart();
    return {
      requestedAt: requestedAt.toISOString(),
      backupCreatedAt: located.base.endAt.toISOString(),
      pointInTime: to?.toISOString() ?? null,
    };
  }

  /** The recovery key for the Owner to keep on paper (P7-05b). Audited. */
  async recoveryKey(principal: Principal): Promise<RecoveryKeyResponse> {
    const key = await this.secrets.get(BACKUP_KEY);
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'BACKUP_RECOVERY_KEY_SHOWN',
        entityType: 'backup',
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { keyId: backupKeyId(key) },
      }),
    );
    return { recoveryKey: formatRecoveryKey(key), keyId: backupKeyId(key) };
  }

  /**
   * The restore tool leaves a record in the restored database; the server audits it once when it
   * starts (AUD-001), naming the Owner who asked for it from the System page.
   */
  async auditRestore(): Promise<boolean> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: RESTORE_RECORD_KEY } });
    if (row === null) return false;
    let parsed;
    try {
      parsed = RestoreRecord.safeParse(JSON.parse(row.value));
    } catch {
      return false;
    }
    if (!parsed.success || parsed.data.audited) return false;
    const record = parsed.data;
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    await this.prisma.transaction(async (tx) => {
      for (const { id } of restaurants) {
        await this.audit.record(tx, {
          action: 'BACKUP_RESTORED',
          entityType: 'backup',
          restaurantId: id,
          ...(record.requestedBy !== null && {
            actorId: record.requestedBy.staffId,
            deviceId: record.requestedBy.deviceId,
          }),
          after: {
            restoredAt: record.restoredAt,
            backupCreatedAt: record.backupCreatedAt,
            fileName: record.fileName,
            restoredTo: record.restoredTo,
          },
          reason: 'Restored from a backup',
        });
      }
      await tx.systemMeta.update({
        where: { key: RESTORE_RECORD_KEY },
        data: { value: JSON.stringify({ ...record, audited: true }) },
      });
    });
    return true;
  }

  /** The Backups part of the System page. */
  async overview(restaurantId: string): Promise<BackupsResponse> {
    const settings = await this.settings.snapshot(restaurantId);
    const now = this.options.now();
    const [summary, runs, key, pending, restored, continuous, cloud] = await Promise.all([
      backupSummary(this.prisma),
      this.prisma.backupRun.findMany({ orderBy: { startedAt: 'desc' }, take: RUNS_SHOWN }),
      this.secrets.get(BACKUP_KEY),
      readRestoreRequest(this.config.dataDir),
      readRestoreOutcome(this.config.dataDir),
      this.continuous.view(),
      this.cloud.view(restaurantId),
    ]);
    const second = settings.get('backups.secondLocation');
    const names = await this.namesOf(runs);
    const nextSlot = lastNightlySlot(now, settings.get('backups.nightlyAt'), DEFAULT_TIME_ZONE);
    return {
      health: backupHealth({ now, ...summary }),
      lastSuccessAt: summary.lastSuccessAt?.toISOString() ?? null,
      nextNightlyAt: new Date(nextSlot.getTime() + 24 * 60 * 60_000).toISOString(),
      running: runs.some((run) => run.status === 'RUNNING'),
      locations: [
        {
          location: 'DATA_DRIVE',
          path: this.dataDriveFolder,
          ...(await this.filesIn(this.dataDriveFolder)),
        },
        second === null
          ? { location: 'SECOND', path: null, available: false, files: [] }
          : {
              location: 'SECOND',
              path: join(second, SECOND_FOLDER),
              ...(await this.filesIn(join(second, SECOND_FOLDER))),
            },
      ],
      runs: runs.map((run) => this.viewOf(run, names)),
      keyId: backupKeyId(key),
      continuous,
      cloud,
      restorePending: pending !== null,
      lastRestore:
        restored === null
          ? null
          : {
              at: restored.at,
              ok: restored.ok,
              error: restored.error,
              backupCreatedAt: restored.backupCreatedAt,
              restoredTo: restored.restoredTo,
              previousDatabase: restored.previousDatabase,
            },
    };
  }

  private async namesOf(runs: readonly BackupRun[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(runs.flatMap((run) => (run.requestedById === null ? [] : [run.requestedById]))),
    ];
    const staff =
      ids.length === 0
        ? []
        : await this.prisma.staff.findMany({
            where: { id: { in: ids } },
            select: { id: true, displayName: true },
          });
    return new Map(staff.map((person) => [person.id, person.displayName]));
  }

  private viewOf(run: BackupRun, names: ReadonlyMap<string, string>): BackupRunView {
    return {
      id: run.id,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      fileName: run.fileName,
      sizeBytes: run.sizeBytes === null ? null : Number(run.sizeBytes),
      secondCopy: (run.secondCopy as BackupRunView['secondCopy']) ?? null,
      cloud: (run.cloudStatus as BackupRunView['cloud']) ?? null,
      error: run.error,
      requestedBy: run.requestedById === null ? null : (names.get(run.requestedById) ?? null),
    };
  }

  private async filesIn(
    folder: string,
  ): Promise<{ available: boolean; files: BackupsResponse['locations'][number]['files'] }> {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      // A folder not made yet is there, just empty; anything else (an unplugged drive) is not.
      return { available: (error as NodeJS.ErrnoException).code === 'ENOENT', files: [] };
    }
    const files: BackupsResponse['locations'][number]['files'] = [];
    for (const name of names) {
      const takenAt = takenAtOf(name);
      if (takenAt === null) continue;
      const size = await stat(join(folder, name)).then(
        (stats) => stats.size,
        () => null,
      );
      if (size !== null) files.push({ name, takenAt: takenAt.toISOString(), sizeBytes: size });
    }
    files.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    return { available: true, files };
  }

  /** Makes, checks, copies and prunes; records the outcome and alerts on failure. */
  private async make(run: BackupRun): Promise<void> {
    const fileName = `rp-backup-${stampOf(run.startedAt)}-${run.kind.toLowerCase()}.rpbk`;
    let outcome: {
      status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
      sizeBytes?: number;
      sha256?: string;
      secondCopy?: 'COPIED' | 'NOT_SET' | 'FAILED';
      error?: string;
    };
    try {
      const key = await this.secrets.get(BACKUP_KEY);
      const folder = this.dataDriveFolder;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const { sizeBytes, sha256 } = await this.write(run, key, join(folder, fileName));
      const settings = await this.settingsForBackups();
      const second = settings?.get('backups.secondLocation') ?? null;
      let secondCopy: 'COPIED' | 'NOT_SET' | 'FAILED' = 'NOT_SET';
      let error: string | undefined;
      if (second !== null) {
        try {
          await this.copyTo(join(folder, fileName), join(second, SECOND_FOLDER), fileName, key);
          secondCopy = 'COPIED';
        } catch (failure) {
          secondCopy = 'FAILED';
          error = `The copy to the second location failed: ${plainError(failure)}`.slice(0, 480);
          this.logger.warn(
            { err: failure },
            'The backup could not be copied to the second location',
          );
        }
      }
      const keepDaily = settings?.get('backups.keepDaily') ?? 14;
      const keepWeekly = settings?.get('backups.keepWeekly') ?? 8;
      await this.prune(folder, keepDaily, keepWeekly);
      if (secondCopy === 'COPIED' && second !== null) {
        await this.prune(join(second, SECOND_FOLDER), keepDaily, keepWeekly).catch(
          (failure: unknown) => {
            this.logger.warn({ err: failure }, 'Old backups at the second location stay for now');
          },
        );
      }
      outcome = {
        status: secondCopy === 'FAILED' ? 'PARTIAL' : 'SUCCEEDED',
        sizeBytes,
        sha256,
        secondCopy,
        ...(error !== undefined && { error }),
      };
    } catch (failure) {
      this.logger.error({ err: failure }, 'The backup failed');
      outcome = { status: 'FAILED', error: plainError(failure) };
    }
    await this.finish(run, fileName, outcome);
    if (run.kind === 'NIGHTLY' && outcome.status !== 'FAILED') this.cloud.soon();
  }

  private async settingsForBackups() {
    const restaurant = await this.prisma.restaurant.findFirst({ select: { id: true } });
    return restaurant === null ? undefined : this.settings.snapshot(restaurant.id);
  }

  /** Writes the encrypted backup through a partial file, checks it, then gives it its name. */
  private async write(
    run: BackupRun,
    key: Buffer,
    path: string,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const partial = `${path}.partial`;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const dump = runPgTool(
      pgProgram('pg_dump', this.config.pgBin),
      ['--format=custom', '--no-owner', '--no-password'],
      this.config.databaseUrl,
    );
    dump.done.catch(() => undefined);
    try {
      await pipeline(
        Readable.from(writeArchive(withManifest(this.entries(run, dump)))),
        encryptBackup(key, {
          kind: 'FULL',
          appVersion: SERVER_PACKAGE.version,
          now: run.startedAt,
        }),
        counting,
        createWriteStream(partial, { mode: 0o600 }),
      );
      await dump.done;
      await this.sync(partial);
      await verifyBackupFile(createReadStream(partial), key, this.toolOptions());
      await rename(partial, path);
    } catch (error) {
      dump.stdout.destroy();
      await rm(partial, { force: true });
      throw error;
    }
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  private toolOptions() {
    return { pgBin: this.config.pgBin, databaseUrl: this.config.databaseUrl };
  }

  /** What goes in the backup, in order. */
  private async *entries(run: BackupRun, dump: ReturnType<typeof runPgTool>) {
    const info: BackupInfo = {
      format: 1,
      createdAt: run.startedAt.toISOString(),
      kind: run.kind,
      appVersion: SERVER_PACKAGE.version,
      schemaVersion: await this.schemaVersion(),
      postgresVersion: await this.postgresVersion(),
      restaurants: (
        await this.prisma.restaurant.findMany({ select: { id: true, displayName: true } })
      ).map((restaurant) => ({ id: restaurant.id, name: restaurant.displayName })),
    };
    yield { name: BACKUP_INFO, content: [JSON.stringify(info)] };
    yield { name: DATABASE_DUMP, content: dump.stdout as AsyncIterable<Buffer> };
    const secrets: BackupSecrets = { format: 1, secrets: {} };
    for (const name of SECRET_NAMES) {
      if (name === BACKUP_KEY) continue;
      secrets.secrets[name] = (await this.secrets.get(name)).toString('base64');
    }
    yield { name: SECRETS, content: [JSON.stringify(secrets)] };
    yield* folderEntries(this.config.dataDir, 'photos');
    yield* folderEntries(this.config.dataDir, 'tls');
  }

  /** The newest migration applied; null where migrations were applied without Prisma (tests). */
  private async schemaVersion(): Promise<string | null> {
    const [table] = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
    if (table?.present !== true) return null;
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT migration_name AS name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`;
    return rows[0]?.name ?? null;
  }

  private async postgresVersion(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ version: string }[]>`SHOW server_version`;
    return rows[0]?.version ?? null;
  }

  private async sync(path: string): Promise<void> {
    const handle = await open(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Copies a checked backup to the second location, checks the copy, then names it. */
  private async copyTo(source: string, folder: string, fileName: string, key: Buffer) {
    await mkdir(folder, { recursive: true });
    const target = join(folder, fileName);
    const partial = `${target}.partial`;
    try {
      await pipeline(createReadStream(source), createWriteStream(partial, { mode: 0o600 }));
      await this.sync(partial);
      await verifyBackupFile(createReadStream(partial), key, this.toolOptions());
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  /** Removes the backups the retention no longer keeps, and partial files left by a crash. */
  private async prune(folder: string, keepDaily: number, keepWeekly: number): Promise<void> {
    const names = await readdir(folder);
    const backups = names.flatMap((name) => {
      const takenAt = takenAtOf(name);
      return takenAt === null ? [] : [{ name, takenAt }];
    });
    for (const name of backupsToRemove(backups, keepDaily, keepWeekly)) {
      await rm(join(folder, name), { force: true });
    }
    for (const name of names.filter((entry) => entry.endsWith('.rpbk.partial'))) {
      const age = this.options.now().getTime() - (await stat(join(folder, name))).mtimeMs;
      if (age > 24 * 60 * 60_000) await rm(join(folder, name), { force: true });
    }
  }

  private async finish(
    run: BackupRun,
    fileName: string,
    outcome: {
      status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
      sizeBytes?: number;
      sha256?: string;
      secondCopy?: 'COPIED' | 'NOT_SET' | 'FAILED';
      error?: string;
    },
  ): Promise<void> {
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    await this.prisma.transaction(async (tx) => {
      await tx.backupRun.update({
        where: { id: run.id },
        data: {
          status: outcome.status,
          finishedAt: this.options.now(),
          fileName: outcome.status === 'FAILED' ? null : fileName,
          sizeBytes: outcome.sizeBytes ?? null,
          sha256: outcome.sha256 ?? null,
          secondCopy: outcome.secondCopy ?? null,
          error: outcome.error ?? null,
          // DATA-003: each nightly backup made goes to the cloud (P7-05d).
          ...(run.kind === 'NIGHTLY' && outcome.status !== 'FAILED' && { cloudStatus: 'PENDING' }),
        },
      });
      for (const { id } of restaurants) {
        // DATA-005: the Owner and managers hear about a failure until a backup works again.
        if (outcome.status === 'SUCCEEDED') {
          await this.notifications.clear(tx, { restaurantId: id, dedupeKey: 'backup' });
        } else {
          await this.notifications.raise(tx, {
            restaurantId: id,
            type: 'DISK_OR_BACKUP',
            dedupeKey: 'backup',
            payload: { backup: outcome.status, error: outcome.error ?? null },
          });
        }
        await this.audit.record(tx, {
          action: outcome.status === 'FAILED' ? 'BACKUP_FAILED' : 'BACKUP_COMPLETED',
          entityType: 'backup_run',
          entityId: run.id,
          restaurantId: id,
          ...(run.requestedById !== null && { actorId: run.requestedById }),
          after: {
            kind: run.kind,
            status: outcome.status,
            fileName: outcome.status === 'FAILED' ? null : fileName,
            sizeBytes: outcome.sizeBytes ?? null,
            secondCopy: outcome.secondCopy ?? null,
          },
          reason: outcome.error ?? null,
        });
      }
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runIfDue()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Checking whether the nightly backup is due failed');
        })
        .finally(() => {
          this.schedule(this.options.checkEveryMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
