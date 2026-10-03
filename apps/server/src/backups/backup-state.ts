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
