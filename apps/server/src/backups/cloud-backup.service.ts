import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { CloudBackupStatusView } from '@rp/contracts';
import { cloudBackupState } from '@rp/domain';
import { readEnrolment } from '../cloud/control-plane-state.js';
import type { ControlPlaneClient } from '../cloud/control-plane-client.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import type { BackupRun } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { readBackupHeader } from './backup-file.js';
import { backupKeyId } from './backup-file.js';
import { cloudBackupSummary } from './backup-state.js';
import { readEscrowedKey } from './escrow-state.js';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';

export const CLOUD_BACKUP_OPTIONS = Symbol('CLOUD_BACKUP_OPTIONS');

export interface CloudBackupOptions {
  /** Wait after start-up before the first look. */
  readonly firstDelayMs: number;
  /** How often to look for a backup to send; 0 never looks by itself (tests). */
  readonly checkEveryMs: number;
  /** After a failed upload, wait this long before trying again. */
  readonly retryAfterMs: number;
  /** Tries per part before the upload counts as failed, and the wait between them. */
  readonly partAttempts: number;
  readonly partRetryMs: number;
  readonly now: () => Date;
  /** The PUTs to object storage; tests pass their own. */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_CLOUD_BACKUP_OPTIONS: CloudBackupOptions = {
  firstDelayMs: 3 * 60_000,
  checkEveryMs: 15 * 60_000,
  retryAfterMs: 60 * 60_000,
  partAttempts: 4,
  partRetryMs: 5_000,
  now: () => new Date(),
};

/** One part may take a while over slow broadband: 64 MiB at 1 Mbps is about 9 minutes. */
const PART_TIMEOUT_MS = 30 * 60_000;
const DEDUPE_KEY = 'cloud-backup';

export type CloudBackupOutcome =
  'UPLOADED' | 'FAILED' | 'NOTHING' | 'OFF' | 'NOT_SET_UP' | 'WAITING';

function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 480);
}

/** Reads `length` bytes of a file from `offset`. */
async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) throw new Error('The backup file is shorter than expected');
      filled += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * The encrypted cloud backup (DATA-003, DATA-005, P7-05d). Each nightly backup, already encrypted
 * on this PC with its backup key (AES-256-GCM), is uploaded to the vendor's storage in India: the
 * Control Plane gives signed URLs and the parts go straight to storage. Only the newest waiting
 * backup is sent; an older one still waiting is skipped. Without the internet it waits and tries
 * again every hour (NFR-A04); after a day with nothing sent, the Owner and managers are alerted.
 * The Owner may opt out (`backups.cloudEnabled`, an audited setting change).
 */
@Injectable()
export class CloudBackupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CloudBackupService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private current: Promise<CloudBackupOutcome> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly heartbeat: HeartbeatService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOUD_BACKUP_OPTIONS) private readonly options: CloudBackupOptions,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.checkEveryMs > 0 && this.config.controlPlaneUrl !== undefined) {
      this.schedule(this.options.firstDelayMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  /** After a nightly backup: send it soon rather than at the next look. */
  soon(): void {
    if (this.options.checkEveryMs > 0) this.schedule(5_000);
  }

  /** Sends the newest waiting backup, when there is one and it may be sent. One at a time. */
  runIfDue(): Promise<CloudBackupOutcome> {
    const run = (this.current ?? Promise.resolve('NOTHING' as CloudBackupOutcome))
      .catch((): CloudBackupOutcome => 'NOTHING')
      .then(() => this.sendNewest());
    this.current = run;
    return run;
  }

  /** The System page's view of it. */
  async view(restaurantId: string): Promise<CloudBackupStatusView> {
    const settings = await this.settings.snapshot(restaurantId);
    const [summary, escrowed, key] = await Promise.all([
      cloudBackupSummary(this.prisma),
      readEscrowedKey(this.prisma),
      this.secrets.get('backup-key'),
    ]);
    return {
      state: cloudBackupState({
        enabled: settings.get('backups.cloudEnabled'),
        setUp: await this.isSetUp(),
        now: this.options.now(),
        lastSuccessAt: summary.lastSuccessAt,
        lastFailureAt: summary.lastFailureAt,
      }),
      lastUploadAt: summary.lastSuccessAt?.toISOString() ?? null,
      lastUploadedBackupAt: summary.lastUploadedBackupAt?.toISOString() ?? null,
      lastFailureAt: summary.lastFailureAt?.toISOString() ?? null,
      lastError: summary.lastError,
      keyEscrowedAt: escrowed?.keyId === backupKeyId(key) ? escrowed.at : null,
    };
  }

  private async isSetUp(): Promise<boolean> {
    return (
      this.config.controlPlaneUrl !== undefined && (await readEnrolment(this.prisma)) !== undefined
    );
  }

  private async sendNewest(): Promise<CloudBackupOutcome> {
    const restaurant = await this.prisma.restaurant.findFirst({ select: { id: true } });
    if (restaurant === null) return 'NOTHING';
    const settings = await this.settings.snapshot(restaurant.id);
    const waiting = await this.prisma.backupRun.findMany({
      where: { cloudStatus: { in: ['PENDING', 'FAILED'] } },
      orderBy: { startedAt: 'desc' },
    });
    const [newest, ...older] = waiting;
    if (newest === undefined) return 'NOTHING';
    // Left waiting while off, so turning it back on sends the newest straight away.
    if (!settings.get('backups.cloudEnabled')) return 'OFF';
    if (older.length > 0) {
      await this.prisma.backupRun.updateMany({
        where: { id: { in: older.map((run) => run.id) } },
        data: { cloudStatus: 'SKIPPED', cloudError: 'A newer backup was sent instead.' },
      });
    }
    const now = this.options.now();
    if (
      newest.cloudStatus === 'FAILED' &&
      newest.cloudAttemptedAt !== null &&
      now.getTime() - newest.cloudAttemptedAt.getTime() < this.options.retryAfterMs
    ) {
      return 'WAITING';
    }
    const connection = await this.heartbeat.connection();
    if ('unavailable' in connection) return 'NOT_SET_UP';
    const path =
      newest.fileName === null
        ? null
        : join(this.config.dataDir, 'backups', 'full', newest.fileName);
    if (path === null || newest.sha256 === null) {
      await this.prisma.backupRun.update({
        where: { id: newest.id },
        data: { cloudStatus: 'SKIPPED', cloudError: 'The backup file is not there any more.' },
      });
      return 'NOTHING';
    }
    let outcome: CloudBackupOutcome;
    try {
      const cloudBackupId = await this.upload(
        connection.client,
        connection.installationId,
        newest,
        path,
        newest.sha256,
      );
      await this.prisma.backupRun.update({
        where: { id: newest.id },
        data: {
          cloudStatus: 'UPLOADED',
          cloudAttemptedAt: now,
          cloudUploadedAt: this.options.now(),
          cloudError: null,
          cloudBackupId,
        },
      });
      this.logger.log({ fileName: newest.fileName }, 'The backup is in the cloud');
      outcome = 'UPLOADED';
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      await this.prisma.backupRun.update({
        where: { id: newest.id },
        data: {
          cloudStatus: missing ? 'SKIPPED' : 'FAILED',
          cloudAttemptedAt: now,
          cloudError: missing
            ? 'The backup file is not there any more.'
            : `The upload to the cloud failed: ${plainError(error)}`.slice(0, 480),
        },
      });
      this.logger.warn({ err: error }, 'The backup could not be sent to the cloud');
      outcome = 'FAILED';
    }
    await this.alert(restaurant.id);
    return outcome;
  }

  /** Uploads the file in the parts the Control Plane asks for; returns its record's id. */
  private async upload(
    client: ControlPlaneClient,
    installationId: string,
    run: BackupRun,
    path: string,
    sha256: string,
  ): Promise<string> {
    const [header, file] = await Promise.all([readBackupHeader(path), stat(path)]);
    const started = await client.startCloudBackup(installationId, {
      fileName: run.fileName ?? '',
      backupCreatedAt: new Date(header.createdAt).toISOString(),
      sizeBytes: file.size,
      sha256,
      keyId: header.keyId,
    });
    if (started.status === 'COMPLETE') return started.id;
    try {
      const parts: { number: number; etag: string }[] = [];
      for (const part of started.parts) {
        const offset = (part.number - 1) * started.partSize;
        const bytes = await readRange(path, offset, Math.min(started.partSize, file.size - offset));
        parts.push({
          number: part.number,
          etag: await this.put(client.resolveUrl(part.url), bytes),
        });
      }
      await client.completeCloudBackup(installationId, started.id, { parts });
    } catch (error) {
      await client.abortCloudBackup(installationId, started.id).catch(() => undefined);
      throw error;
    }
    return started.id;
  }

  /** PUTs one part, with its MD5 so storage refuses a damaged one; tries a few times. */
  private async put(url: string, bytes: Buffer): Promise<string> {
    const md5 = createHash('md5').update(bytes).digest('base64');
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.partAttempts; attempt += 1) {
      try {
        const response = await (this.options.fetch ?? fetch)(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'content-md5': md5 },
          body: bytes,
          redirect: 'error',
          signal: AbortSignal.timeout(PART_TIMEOUT_MS),
        });
        await response.arrayBuffer().catch(() => undefined);
        const etag = response.headers.get('etag');
        if (response.ok && etag !== null) return etag;
        lastError = new Error(`storage answered ${String(response.status)}`);
        // A refused or expired URL will not work the next time either.
        if (response.status >= 400 && response.status < 500 && response.status !== 408) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < this.options.partAttempts) {
        await new Promise((resolve) => setTimeout(resolve, this.options.partRetryMs * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** DATA-005: alert while nothing reached the cloud for a day and the last try failed. */
  private async alert(restaurantId: string): Promise<void> {
    const view = await this.view(restaurantId);
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    await this.prisma.transaction(async (tx) => {
      for (const { id } of restaurants) {
        if (view.state === 'FAILING') {
          await this.notifications.raise(tx, {
            restaurantId: id,
            type: 'DISK_OR_BACKUP',
            dedupeKey: DEDUPE_KEY,
            payload: { cloudBackup: 'FAILING', error: view.lastError },
          });
        } else {
          await this.notifications.clear(tx, { restaurantId: id, dedupeKey: DEDUPE_KEY });
        }
      }
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runIfDue()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Sending the backup to the cloud failed');
        })
        .finally(() => {
          this.schedule(this.options.checkEveryMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
