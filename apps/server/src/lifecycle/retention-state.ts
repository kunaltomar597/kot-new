import { z } from 'zod';
import type { PrismaService } from '../database/prisma.service.js';

/** The last run of the automatic retention (P7-06a), for the System page. */
export const RETENTION_LAST_RUN = 'retention.last_run';

export const RetentionRun = z.object({
  at: z.iso.datetime(),
  /** Rows removed or anonymised and files removed, in all. */
  total: z.int().nonnegative(),
});
export type RetentionRun = z.infer<typeof RetentionRun>;

export async function readRetentionRun(
  prisma: Pick<PrismaService, 'systemMeta'>,
): Promise<RetentionRun | null> {
  const row = await prisma.systemMeta.findUnique({ where: { key: RETENTION_LAST_RUN } });
  if (row === null) return null;
  try {
    const parsed = RetentionRun.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveRetentionRun(
  prisma: Pick<PrismaService, 'systemMeta'>,
  run: RetentionRun,
): Promise<void> {
  const value = JSON.stringify(run);
  await prisma.systemMeta.upsert({
    where: { key: RETENTION_LAST_RUN },
    create: { key: RETENTION_LAST_RUN, value },
    update: { value },
  });
}
