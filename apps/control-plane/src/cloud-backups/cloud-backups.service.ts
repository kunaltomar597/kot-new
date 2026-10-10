import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CLOUD_BACKUP_CLOCK_MARGIN_MS,
  CLOUD_BACKUPS_PER_DAY,
  cloudFileKindOf,
  type CloudBackupView,
  CompleteCloudBackupRequest,
  StartCloudBackupRequest,
  StartCloudBackupResponse,
} from '@rp/contracts/control-plane';
import { backupsToRemove } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { lockFor } from '../database/advisory-lock.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { CloudBackup } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { type ObjectStore, partCount } from './object-store.js';

export const OBJECT_STORE = Symbol('OBJECT_STORE');

/** How long the part URLs work: a large backup over slow broadband takes hours. */
const UPLOAD_URL_SECONDS = 24 * 60 * 60;
/** An upload still not complete after this is given up and its parts removed. */
const STALE_UPLOAD_MS = 2 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const errors = {
  off: () =>
    new CpError(503, 'CLOUD_BACKUP_OFF', 'The cloud backup is not set up at the vendor yet.'),
  notFound: () => new CpError(404, 'NOT_FOUND', 'No such upload for this PC.'),
  closed: () =>
    new CpError(409, 'CLOUD_BACKUP_CLOSED', 'This upload was given up or is already complete.'),
};

function view(row: CloudBackup): CloudBackupView {
  return {
    id: row.id,
    installationId: row.installationId,
    fileName: row.fileName,
    backupCreatedAt: row.backupCreatedAt.toISOString(),
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    keyId: row.keyId,
    kind: row.kind === 'ARCHIVE' ? 'ARCHIVE' : 'BACKUP',
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/**
 * The encrypted cloud backup (DATA-003, P7-05d). A restaurant PC starts an upload of its nightly
 * backup file, PUTs the parts straight to object storage with the signed URLs it gets, then
 * completes it. The file is encrypted on the PC with a key the Control Plane does not hold. The
 * retention keeps the newest of each of the last 30 days and 12 months per PC (BRD §9.3).
 *
 * A PC is not trusted with what is kept (threat CP-T2: ransomware on it, or its stolen key): the
 * retention goes by when the Control Plane stored each backup, never by the date the PC gives, a
 * date after the Control Plane's clock is refused, and a PC starts 8 files a day at most. So
 * whatever a PC sends, the backups stored before it went wrong stay for their 30 days and months.
 */
@Injectable()
export class CloudBackupsService {
  private readonly logger = new Logger(CloudBackupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore | null,
  ) {}

  private storeOrFail(): ObjectStore {
    if (this.store === null) throw errors.off();
    return this.store;
  }

  async start(
    installationId: string,
    request: StartCloudBackupRequest,
    now = new Date(),
  ): Promise<StartCloudBackupResponse> {
    const store = this.storeOrFail();
    const expiresAt = new Date(now.getTime() + UPLOAD_URL_SECONDS * 1_000).toISOString();
    const stored = await this.prisma.cloudBackup.findFirst({
      where: { installationId, sha256: request.sha256, status: 'COMPLETE' },
    });
    if (stored !== null) {
      return { id: stored.id, status: 'COMPLETE', partSize: stored.partSize, parts: [], expiresAt };
    }
    const createdAt = new Date(request.backupCreatedAt);
    if (createdAt.getTime() > now.getTime() + CLOUD_BACKUP_CLOCK_MARGIN_MS) {
      throw new CpError(
        422,
        'CLOUD_BACKUP_DATE',
        'The backup says it was made later than now. Check the PC’s clock.',
      );
    }
    // An earlier attempt at the same file that never finished: given up, its parts removed.
    const earlier = await this.prisma.cloudBackup.findMany({
      where: { installationId, sha256: request.sha256, status: 'UPLOADING' },
    });
    for (const row of earlier) await this.abortRow(row, now);

    const id = newId();
    const objectKey = `backups/${installationId}/${id}.rpbk`;
    const upload = await this.prisma.transaction(async (tx) => {
      // One start at a time per PC, so starts sent together cannot pass the day's number.
      await lockFor(tx, `cloud-backup:${installationId}`);
      const today = await tx.cloudBackup.findMany({
        where: {
          installationId,
          startedAt: { gt: new Date(now.getTime() - DAY_MS) },
          sha256: { not: request.sha256 },
        },
        distinct: ['sha256'],
        select: { sha256: true },
      });
      if (today.length >= CLOUD_BACKUPS_PER_DAY) {
        throw new CpError(
          429,
          'CLOUD_BACKUP_LIMIT',
          `This PC started ${String(CLOUD_BACKUPS_PER_DAY)} backups in the last day. The next one goes later.`,
        );
      }
      const started = await store.startUpload(objectKey, request.sizeBytes, UPLOAD_URL_SECONDS);
      await tx.cloudBackup.create({
        data: {
          id,
          installationId,
          objectKey,
          fileName: request.fileName,
          backupCreatedAt: createdAt,
          sizeBytes: BigInt(request.sizeBytes),
          sha256: request.sha256,
          keyId: request.keyId,
          kind: cloudFileKindOf(request.fileName),
          uploadId: started.uploadId,
          partSize: started.partSize,
          startedAt: now,
        },
      });
      return started;
    });
    return {
      id,
      status: 'UPLOADING',
      partSize: upload.partSize,
      parts: [...upload.parts],
      expiresAt,
    };
  }

  async complete(
    installationId: string,
    id: string,
    request: CompleteCloudBackupRequest,
    now = new Date(),
  ): Promise<CloudBackupView> {
    const store = this.storeOrFail();
    const row = await this.prisma.cloudBackup.findUnique({ where: { id } });
    if (row?.installationId !== installationId) throw errors.notFound();
    if (row.status === 'COMPLETE') return view(row);
    if (row.status !== 'UPLOADING' || row.uploadId === null) throw errors.closed();
    const expected = partCount(Number(row.sizeBytes), row.partSize);
    const numbers = new Set(request.parts.map((part) => part.number));
    if (
      numbers.size !== request.parts.length ||
      numbers.size !== expected ||
      [...numbers].some((number) => number > expected)
    ) {
      throw new CpError(
        422,
        'CLOUD_BACKUP_INCOMPLETE',
        `Every part, 1 to ${String(expected)}, must be uploaded once.`,
      );
    }
    try {
      await store.completeUpload(row.objectKey, row.uploadId, request.parts);
    } catch (error) {
      this.logger.warn({ err: error, id }, 'The object store refused to join the parts');
      throw new CpError(
        422,
        'CLOUD_BACKUP_INCOMPLETE',
        'The uploaded parts could not be joined. Upload the backup again.',
      );
    }
    const size = await store.sizeOf(row.objectKey);
    if (size !== Number(row.sizeBytes)) {
      await store.remove(row.objectKey).catch(() => undefined);
      await this.prisma.cloudBackup.update({
        where: { id },
        data: { status: 'ABORTED', uploadId: null, endedAt: now },
      });
      throw new CpError(
        422,
        'CLOUD_BACKUP_SIZE_MISMATCH',
        'The stored backup is not the size of the file. Upload it again.',
      );
    }
    const done = await this.prisma.transaction(async (tx) => {
      const updated = await tx.cloudBackup.update({
        where: { id },
        data: { status: 'COMPLETE', uploadId: null, completedAt: now },
      });
      await this.audit.record(tx, {
        actor: `installation:${installationId}`,
        action: 'cloud_backup.stored',
        targetType: 'installation',
        targetId: installationId,
        details: {
          cloudBackupId: id,
          fileName: row.fileName,
          sizeBytes: Number(row.sizeBytes),
          backupCreatedAt: row.backupCreatedAt.toISOString(),
        },
      });
      return updated;
    });
    await this.prune(installationId, now).catch((error: unknown) => {
      this.logger.warn({ err: error, installationId }, 'Old cloud backups stay for now');
    });
    return view(done);
  }

  async abort(installationId: string, id: string, now = new Date()): Promise<void> {
    const row = await this.prisma.cloudBackup.findUnique({ where: { id } });
    if (row?.installationId !== installationId) throw errors.notFound();
    if (row.status === 'UPLOADING') await this.abortRow(row, now);
  }

  /** The PC's backups kept in the cloud, newest first. */
  async list(installationId: string): Promise<CloudBackupView[]> {
    const rows = await this.prisma.cloudBackup.findMany({
      where: { installationId, status: 'COMPLETE' },
      orderBy: { backupCreatedAt: 'desc' },
    });
    return rows.map(view);
  }

  /** For vendor staff: a PC's cloud backups (the files stay encrypted). */
  async listForVendor(installationId: string): Promise<CloudBackupView[]> {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      select: { id: true },
    });
    if (installation === null) {
      throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
    }
    return this.list(installationId);
  }

  /**
   * Retention (BRD §9.3: 30 daily and 12 monthly by default) for one PC, and uploads left
   * unfinished for two days. Removed objects keep their row, marked DELETED. Days and months are
   * those the Control Plane stored each backup in, never the date the PC gave (threat CP-T2).
   */
  async prune(installationId: string, now = new Date()): Promise<string[]> {
    const store = this.storeOrFail();
    const stale = await this.prisma.cloudBackup.findMany({
      where: {
        installationId,
        status: 'UPLOADING',
        startedAt: { lt: new Date(now.getTime() - STALE_UPLOAD_MS) },
      },
    });
    for (const row of stale) await this.abortRow(row, now);
    // Archived years are kept for good (DATA-008): the retention is for nightly backups.
    const kept = await this.prisma.cloudBackup.findMany({
      where: { installationId, status: 'COMPLETE', kind: 'BACKUP' },
    });
    const remove = new Set(
      backupsToRemove(
        kept.map((row) => ({ name: row.id, takenAt: row.completedAt ?? row.startedAt })),
        this.config.backupKeepDaily,
        0,
        undefined,
        this.config.backupKeepMonthly,
      ),
    );
    const removed: string[] = [];
    for (const row of kept.filter((entry) => remove.has(entry.id))) {
      await store.remove(row.objectKey);
      await this.prisma.cloudBackup.update({
        where: { id: row.id },
        data: { status: 'DELETED', endedAt: now },
      });
      removed.push(row.fileName);
    }
    if (removed.length > 0) {
      await this.prisma.transaction((tx) =>
        this.audit.record(tx, {
          actor: 'system:retention',
          action: 'cloud_backup.removed',
          targetType: 'installation',
          targetId: installationId,
          details: { fileNames: removed },
        }),
      );
    }
    return removed;
  }

  private async abortRow(row: CloudBackup, now: Date): Promise<void> {
    if (row.uploadId !== null) {
      await this.storeOrFail()
        .abortUpload(row.objectKey, row.uploadId)
        .catch((error: unknown) => {
          this.logger.warn({ err: error, id: row.id }, 'An upload could not be aborted');
        });
    }
    await this.prisma.cloudBackup.update({
      where: { id: row.id },
      data: { status: 'ABORTED', uploadId: null, endedAt: now },
    });
  }
}
