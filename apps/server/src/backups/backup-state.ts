import type { PrismaService } from '../database/prisma.service.js';

export interface BackupSummary {
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  /** The latest failure's words, while it is newer than the latest success. */
  readonly lastError: string | null;
}

/**
 * The latest backup success and failure (DATA-005), for the heartbeat and the System page. A
 * PARTIAL backup (not copied to the second location) counts as a failure.
 */
export async function backupSummary(
  prisma: Pick<PrismaService, 'backupRun'>,
): Promise<BackupSummary> {
  const [success, failure] = await Promise.all([
    prisma.backupRun.findFirst({
      where: { status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
      select: { finishedAt: true, startedAt: true },
    }),
    prisma.backupRun.findFirst({
      where: { status: { in: ['FAILED', 'PARTIAL'] } },
      orderBy: { startedAt: 'desc' },
      select: { finishedAt: true, startedAt: true, error: true },
    }),
  ]);
  const lastSuccessAt = success === null ? null : (success.finishedAt ?? success.startedAt);
  const lastFailureAt = failure === null ? null : (failure.finishedAt ?? failure.startedAt);
  return {
    lastSuccessAt,
    lastFailureAt,
    lastError:
      failure !== null &&
      lastFailureAt !== null &&
      (lastSuccessAt === null || lastFailureAt > lastSuccessAt)
        ? failure.error
        : null,
  };
}

export interface CloudBackupSummary {
  /** When a backup last reached the cloud, and when that backup was made. */
  readonly lastSuccessAt: Date | null;
  readonly lastUploadedBackupAt: Date | null;
  /** The latest upload still failing, and why. */
  readonly lastFailureAt: Date | null;
  readonly lastError: string | null;
}

/** The cloud backup's latest success and failure (DATA-003, P7-05d), from the backup record. */
export async function cloudBackupSummary(
  prisma: Pick<PrismaService, 'backupRun'>,
): Promise<CloudBackupSummary> {
  const [success, failure] = await Promise.all([
    prisma.backupRun.findFirst({
      where: { cloudStatus: 'UPLOADED' },
      orderBy: { cloudUploadedAt: 'desc' },
      select: { cloudUploadedAt: true, startedAt: true },
    }),
    prisma.backupRun.findFirst({
      where: { cloudStatus: 'FAILED' },
      orderBy: { cloudAttemptedAt: 'desc' },
      select: { cloudAttemptedAt: true, cloudError: true },
    }),
  ]);
  return {
    lastSuccessAt: success?.cloudUploadedAt ?? null,
    lastUploadedBackupAt: success?.startedAt ?? null,
    lastFailureAt: failure?.cloudAttemptedAt ?? null,
    lastError: failure?.cloudError ?? null,
  };
}
