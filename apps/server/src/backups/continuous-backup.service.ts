import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ContinuousBackupView } from '@rp/contracts';
import {
  BACKUP_RETRY_MS,
  type BaseBackupInfo,
  baseBackupsToRemove,
  continuousBackupState,
  DEFAULT_TIME_ZONE,
  lastNightlySlot,
  WAL_FILE_NAME,
  type WalMode,
  walFilesToRemove,
  walSwitchEveryMs,
} from '@rp/domain';
import pg from 'pg';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { takeBaseBackup } from './base-backup.js';
import {
  type ArchivedSystem,
  archiveWalFile,
  baseFolder,
  copyArchivedFile,
  listArchive,
  stagingFolder,
  WAL_SUFFIX,
  walFolder,
} from './wal-archive.js';

export const CONTINUOUS_BACKUP_OPTIONS = Symbol('CONTINUOUS_BACKUP_OPTIONS');

export interface ContinuousBackupOptions {
  /** Wait after start-up before the first round. */
  readonly firstDelayMs: number;
  /** How often staged WAL is archived and copied; 0 never runs by itself (tests). */
  readonly shipEveryMs: number;
  /** How often the base backup and the retention are looked at. */
  readonly baseEveryMs: number;
  readonly now: () => Date;
}

export const DEFAULT_CONTINUOUS_BACKUP_OPTIONS: ContinuousBackupOptions = {
  firstDelayMs: 60_000,
  shipEveryMs: 30_000,
  baseEveryMs: 5 * 60_000,
  now: () => new Date(),
};

/** The secret that opens the backups. */
const BACKUP_KEY = 'backup-key';
/** The archive's folder at the second location, beside the full backups (P7-05a). */
const SECOND_FOLDER = 'rp-backups';
const DEDUPE_KEY = 'continuous-backup';
/** Files a crash left half-written are removed after a day. */
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60_000;

function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 480);
}

async function namesIn(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The settings the continuous backup reads; defaults before the first run makes a restaurant. */
interface Settings {
  readonly mode: WalMode;
  readonly nightlyAt: string;
  readonly secondLocation: string | null;
  readonly days: number;
  readonly restaurantIds: readonly string[];
}

/**
 * The continuous backup (DATA-002, DATA-004, DATA-005, P7-05c). PostgreSQL hands each finished
 * piece of its log (WAL) to `wal-stage`; this service:
 *
 * - every 30 seconds encrypts what is staged into the archive on the data drive (checked), copies
 *   it to the second location (checked), and closes the log every 5 minutes (`backups.walMode`
 *   CONTINUOUS) or every hour, so that much is the most a restore can lose;
 * - every night takes a base backup (`pg_basebackup`), checks it and copies it;
 * - keeps `backups.pointInTimeDays` of base backups and the log since the oldest of them;
 * - alerts the Owner and managers while it fails, like a failed backup.
 *
 * It needs the installer to turn on PostgreSQL's archiving and set `RP_BACKUP_DATABASE_URL`
 * (P0-16); without them the System page says it is not set up.
 */
@Injectable()
export class ContinuousBackupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ContinuousBackupService.name);
  private readonly timers = new Map<'ship' | 'base', NodeJS.Timeout>();
  private stopped = false;
  private shipping: Promise<void> | undefined;
  private basing: Promise<void> | undefined;
  private lastSwitchAt: Date | undefined;
  private shipError: string | null = null;
  private baseError: { readonly at: Date; readonly message: string } | null = null;
  private alerting: boolean | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CONTINUOUS_BACKUP_OPTIONS) private readonly options: ContinuousBackupOptions,
  ) {}

  onApplicationBootstrap(): void {
    // Only where the installer set it up (P0-16): the backup role says so.
    if (
      this.options.shipEveryMs <= 0 ||
      this.config.backups !== 'on' ||
      this.config.backupDatabaseUrl === undefined
    ) {
      return;
    }
    this.loop('ship', this.options.firstDelayMs, this.options.shipEveryMs, () => this.shipRound());
    this.loop('base', this.options.firstDelayMs, this.options.baseEveryMs, () => this.baseRound());
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    await this.shipping;
    await this.basing;
  }

  /** The data drive's archive root. */
  get dataDriveRoot(): string {
    return join(this.config.dataDir, 'backups');
  }

  /** The second location's archive root, when one is set. */
  secondRoot(secondLocation: string | null): string | null {
    return secondLocation === null ? null : join(secondLocation, SECOND_FOLDER);
  }

  /** Archives what is staged, closes the log when due, copies to the second location; alerts. */
  shipRound(): Promise<void> {
    const work = (this.shipping ?? Promise.resolve()).then(async () => {
      const settings = await this.read();
      try {
        await this.ship();
        await this.switchIfDue(settings.mode);
        this.shipError = null;
      } catch (error) {
        this.shipError = plainError(error);
        this.logger.error({ err: error }, 'The continuous backup could not archive the log');
      }
      // An unplugged second drive is caught up later: shown as behind, not alerted.
      await this.copyWal(settings).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'The log could not be copied to the second location');
      });
      await this.alert(settings);
    });
    this.shipping = work.catch(() => undefined);
    return work;
  }

  /** Takes the nightly base backup when due, copies it, and applies the retention. */
  baseRound(): Promise<void> {
    const work = (this.basing ?? Promise.resolve()).then(async () => {
      const settings = await this.read();
      await this.baseBackupIfDue(settings);
      await this.copyBases(settings).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Base backups could not be copied to the second location');
      });
      await this.prune(settings).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Old continuous backups stay for now');
      });
    });
    this.basing = work.catch(() => undefined);
    return work;
  }

  /** Encrypts every staged WAL file into the data drive's archive, then removes it from staging. */
  async ship(): Promise<number> {
    const staging = stagingFolder(this.config.dataDir);
    let shipped = 0;
    let key: Buffer | undefined;
    for (const systemId of await namesIn(staging)) {
      if (!/^\d+$/.test(systemId)) continue;
      const names = (await namesIn(join(staging, systemId)))
        .filter((name) => WAL_FILE_NAME.test(name))
        .sort();
      for (const name of names) {
        key ??= await this.secrets.get(BACKUP_KEY);
        const source = join(staging, systemId, name);
        await archiveWalFile({
          source,
          target: join(walFolder(this.dataDriveRoot, systemId), `${name}${WAL_SUFFIX}`),
          key,
          appVersion: SERVER_PACKAGE.version,
        });
        await rm(source, { force: true });
        shipped += 1;
      }
    }
    return shipped;
  }

  /** Closes the current piece of the log, so it is archived (DATA-002 "continuous or hourly"). */
  async switchWal(): Promise<void> {
    const url = this.config.backupDatabaseUrl;
    if (url === undefined) return;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // Does nothing when nothing was written since the last switch.
      await client.query('SELECT pg_switch_wal()');
    } finally {
      await client.end();
    }
    this.lastSwitchAt = this.options.now();
  }

  /** Takes a base backup now, onto the data drive (and the second location, by `copyBases`). */
  async baseBackup(): Promise<string> {
    const url = this.config.backupDatabaseUrl;
    if (url === undefined) throw new Error('The continuous backup is not set up on this PC.');
    const { file } = await takeBaseBackup({
      backupDatabaseUrl: url,
      pgBin: this.config.pgBin,
      key: await this.secrets.get(BACKUP_KEY),
      root: this.dataDriveRoot,
      appVersion: SERVER_PACKAGE.version,
      now: this.options.now,
    });
    this.logger.log({ file }, 'Base backup taken');
    return file;
  }

  /** The System page's view of it. */
  async view(): Promise<ContinuousBackupView> {
    const settings = await this.read();
    const now = this.options.now();
    const setUp = await this.isSetUp();
    const systemId = setUp ? await this.currentSystemId() : null;
    const local = await listArchive(this.dataDriveRoot).catch(() => []);
    const mine = local.find((system) => system.systemId === systemId);
    const lastArchivedAt = await this.newestWalTime(mine);
    const waiting = await this.staged();
    const behind = await this.secondBehind(local, settings);
    const bases = mine?.bases ?? [];
    const lastBase = bases.at(-1)?.endAt ?? null;
    const archiverFailing = setUp && (await this.archiverFailing());
    const error = this.shipError ?? this.baseError?.message ?? null;
    return {
      state: continuousBackupState({
        setUp,
        now,
        mode: settings.mode,
        archiverFailing,
        lastError: error,
        oldestWaitingAt: waiting.oldest,
        lastBaseBackupAt: lastBase,
        secondLocationBehind: behind,
      }),
      mode: settings.mode,
      lastArchivedAt: lastArchivedAt?.toISOString() ?? null,
      waiting: waiting.count,
      secondLocationBehind: behind,
      lastBaseBackupAt: lastBase?.toISOString() ?? null,
      restorableFrom: bases[0]?.endAt.toISOString() ?? null,
      error:
        error ??
        (archiverFailing ? 'PostgreSQL cannot hand over its log (check wal-stage).' : null),
    };
  }

  /** PostgreSQL archives its log here and the server has the backup role. */
  async isSetUp(): Promise<boolean> {
    if (this.config.backupDatabaseUrl === undefined) return false;
    const rows = await this.prisma.$queryRaw<{ archive_mode: string }[]>`SHOW archive_mode`;
    return rows[0]?.archive_mode === 'on' || rows[0]?.archive_mode === 'always';
  }

  private async currentSystemId(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT system_identifier::text AS id FROM pg_control_system()`;
    return rows[0]?.id ?? '';
  }

  private async archiverFailing(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ failing: boolean }[]>`
      SELECT coalesce(last_failed_time > coalesce(last_archived_time, '-infinity'), false)
             AS failing
        FROM pg_stat_archiver`;
    return rows[0]?.failing === true;
  }

  private async read(): Promise<Settings> {
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    const first = restaurants[0];
    if (first === undefined) {
      return {
        mode: 'CONTINUOUS',
        nightlyAt: '04:30',
        secondLocation: null,
        days: 2,
        restaurantIds: [],
      };
    }
    const snapshot = await this.settings.snapshot(first.id);
    return {
      mode: snapshot.get('backups.walMode'),
      nightlyAt: snapshot.get('backups.nightlyAt'),
      secondLocation: snapshot.get('backups.secondLocation'),
      days: snapshot.get('backups.pointInTimeDays'),
      restaurantIds: restaurants.map((restaurant) => restaurant.id),
    };
  }

  private async switchIfDue(mode: WalMode): Promise<void> {
    if (this.config.backupDatabaseUrl === undefined) return;
    const now = this.options.now();
    if (
      this.lastSwitchAt !== undefined &&
      now.getTime() - this.lastSwitchAt.getTime() < walSwitchEveryMs(mode)
    ) {
      return;
    }
    if (!(await this.isSetUp())) return;
    await this.switchWal();
  }

  /** The nightly base backup, once a restaurant exists; retried an hour after a failure. */
  private async baseBackupIfDue(settings: Settings): Promise<void> {
    if (settings.restaurantIds.length === 0 || !(await this.isSetUp())) return;
    const now = this.options.now();
    if (this.baseError !== null && now.getTime() - this.baseError.at.getTime() < BACKUP_RETRY_MS) {
      return;
    }
    const systemId = await this.currentSystemId();
    const mine = (await listArchive(this.dataDriveRoot)).find((s) => s.systemId === systemId);
    const slot = lastNightlySlot(now, settings.nightlyAt, DEFAULT_TIME_ZONE);
    if (mine?.bases.some((base) => base.endAt.getTime() >= slot.getTime()) === true) return;
    try {
      await this.baseBackup();
      this.baseError = null;
    } catch (error) {
      this.baseError = { at: now, message: `The base backup failed: ${plainError(error)}` };
      this.logger.error({ err: error }, 'The base backup failed');
    }
    await this.alert(settings);
  }

  /** Copies the log the second location lacks (only what a kept base backup needs). */
  private async copyWal(settings: Settings): Promise<void> {
    const second = this.secondRoot(settings.secondLocation);
    if (second === null) return;
    const key = await this.secrets.get(BACKUP_KEY);
    for (const system of await listArchive(this.dataDriveRoot)) {
      const there = new Set(
        (await namesIn(walFolder(second, system.systemId))).filter((n) => n.endsWith(WAL_SUFFIX)),
      );
      for (const name of this.neededWal(system)) {
        const file = `${name}${WAL_SUFFIX}`;
        if (there.has(file)) continue;
        await copyArchivedFile({
          source: join(walFolder(this.dataDriveRoot, system.systemId), file),
          target: join(walFolder(second, system.systemId), file),
          key,
        });
      }
    }
  }

  private async copyBases(settings: Settings): Promise<void> {
    const second = this.secondRoot(settings.secondLocation);
    if (second === null) return;
    const key = await this.secrets.get(BACKUP_KEY);
    for (const system of await listArchive(this.dataDriveRoot)) {
      const there = new Set(await namesIn(baseFolder(second, system.systemId)));
      for (const base of system.bases) {
        if (there.has(base.name)) continue;
        await copyArchivedFile({
          source: join(baseFolder(this.dataDriveRoot, system.systemId), base.name),
          target: join(baseFolder(second, system.systemId), base.name),
          key,
        });
      }
    }
  }

  /** The WAL a cluster's base backups need: from the oldest one's first segment on. */
  private neededWal(system: ArchivedSystem): readonly string[] {
    const remove = new Set(walFilesToRemove(system.wal, system.bases[0]?.startSegment ?? null));
    return system.wal.filter((name) => !remove.has(name));
  }

  /** Retention in each place: base backups by `backups.pointInTimeDays`, and the log they need. */
  async prune(settings?: Settings): Promise<void> {
    const read = settings ?? (await this.read());
    const roots = [this.dataDriveRoot, this.secondRoot(read.secondLocation)].filter(
      (root): root is string => root !== null,
    );
    const now = this.options.now();
    for (const root of roots) {
      const systems = await listArchive(root);
      const all: BaseBackupInfo[] = systems.flatMap((system) => [...system.bases]);
      const removed = new Set(baseBackupsToRemove(all, now, read.days));
      for (const system of systems) {
        for (const base of system.bases) {
          if (removed.has(base.name)) {
            await rm(join(baseFolder(root, system.systemId), base.name), { force: true });
          }
        }
        const kept = system.bases.filter((base) => !removed.has(base.name));
        // The current cluster's log before its first base backup is kept until one exists.
        if (kept.length === 0 && system.bases.length === 0) continue;
        for (const name of walFilesToRemove(system.wal, kept[0]?.startSegment ?? null)) {
          await rm(join(walFolder(root, system.systemId), `${name}${WAL_SUFFIX}`), {
            force: true,
          });
        }
        await this.removeOldPartials(walFolder(root, system.systemId), now);
        await this.removeOldPartials(baseFolder(root, system.systemId), now);
      }
    }
  }

  private async removeOldPartials(folder: string, now: Date): Promise<void> {
    for (const name of await namesIn(folder)) {
      if (!name.endsWith('.partial')) continue;
      const modified = await stat(join(folder, name)).then(
        (stats) => stats.mtimeMs,
        () => now.getTime(),
      );
      if (now.getTime() - modified > PARTIAL_MAX_AGE_MS) {
        await rm(join(folder, name), { force: true });
      }
    }
  }

  private async staged(): Promise<{ count: number; oldest: Date | null }> {
    const staging = stagingFolder(this.config.dataDir);
    let count = 0;
    let oldest: number | null = null;
    for (const systemId of await namesIn(staging)) {
      for (const name of await namesIn(join(staging, systemId))) {
        if (!WAL_FILE_NAME.test(name)) continue;
        count += 1;
        const modified = await stat(join(staging, systemId, name)).then(
          (stats) => stats.mtimeMs,
          () => null,
        );
        if (modified !== null && (oldest === null || modified < oldest)) oldest = modified;
      }
    }
    return { count, oldest: oldest === null ? null : new Date(oldest) };
  }

  private async newestWalTime(system: ArchivedSystem | undefined): Promise<Date | null> {
    const newest = system?.wal.at(-1);
    if (system === undefined || newest === undefined) return null;
    return stat(
      join(walFolder(this.dataDriveRoot, system.systemId), `${newest}${WAL_SUFFIX}`),
    ).then(
      (stats) => stats.mtime,
      () => null,
    );
  }

  /** Archived files the second location lacks; all of them while it cannot be read. */
  private async secondBehind(
    local: readonly ArchivedSystem[],
    settings: Settings,
  ): Promise<number> {
    const second = this.secondRoot(settings.secondLocation);
    if (second === null) return 0;
    let there: ArchivedSystem[];
    try {
      await stat(settings.secondLocation ?? '');
      there = await listArchive(second);
    } catch {
      return local.reduce(
        (sum, system) => sum + this.neededWal(system).length + system.bases.length,
        0,
      );
    }
    let missing = 0;
    for (const system of local) {
      const remote = there.find((entry) => entry.systemId === system.systemId);
      const wal = new Set(remote?.wal ?? []);
      const bases = new Set(remote?.bases.map((base) => base.name) ?? []);
      missing += this.neededWal(system).filter((name) => !wal.has(name)).length;
      missing += system.bases.filter((base) => !bases.has(base.name)).length;
    }
    return missing;
  }

  /** DATA-005: one alert while it fails, cleared when it works again. */
  private async alert(settings: Settings): Promise<void> {
    const failing = this.shipError !== null || this.baseError !== null;
    if (this.alerting === failing || settings.restaurantIds.length === 0) return;
    await this.prisma.transaction(async (tx) => {
      for (const restaurantId of settings.restaurantIds) {
        if (failing) {
          await this.notifications.raise(tx, {
            restaurantId,
            type: 'DISK_OR_BACKUP',
            dedupeKey: DEDUPE_KEY,
            payload: {
              continuousBackup: 'FAILING',
              error: this.shipError ?? this.baseError?.message ?? null,
            },
          });
        } else {
          await this.notifications.clear(tx, { restaurantId, dedupeKey: DEDUPE_KEY });
        }
      }
    });
    this.alerting = failing;
  }

  private loop(
    lane: 'ship' | 'base',
    delayMs: number,
    everyMs: number,
    round: () => Promise<void>,
  ): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      round()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'A continuous backup round failed');
        })
        .finally(() => {
          this.loop(lane, everyMs, everyMs, round);
        });
    }, delayMs);
    timer.unref();
    this.timers.set(lane, timer);
  }
}
