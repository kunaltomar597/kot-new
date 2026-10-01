import { z } from 'zod';
import type { PrismaService, TransactionClient } from '../database/prisma.service.js';

type Client = PrismaService | TransactionClient;

const INSTALL_APPROVAL_KEY = 'updates.install_approval';

/**
 * A manager's "Install now" (UPD-004), kept in `system_meta` for the updater (P7-04): it installs
 * this version at once instead of waiting for the maintenance window.
 */
export const InstallApproval = z.object({
  version: z.string(),
  approvedAt: z.iso.datetime(),
  approvedByStaffId: z.uuid().nullable(),
});
export type InstallApproval = z.infer<typeof InstallApproval>;

export async function readInstallApproval(prisma: Client): Promise<InstallApproval | null> {
  const row = await prisma.systemMeta.findUnique({ where: { key: INSTALL_APPROVAL_KEY } });
  if (row === null) return null;
  try {
    const parsed = InstallApproval.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveInstallApproval(
  prisma: Client,
  approval: InstallApproval,
): Promise<void> {
  const value = JSON.stringify(approval);
  await prisma.systemMeta.upsert({
    where: { key: INSTALL_APPROVAL_KEY },
    create: { key: INSTALL_APPROVAL_KEY, value },
    update: { value },
  });
}
