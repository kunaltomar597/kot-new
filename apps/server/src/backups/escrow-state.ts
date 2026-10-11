import { z } from 'zod';
import type { PrismaService } from '../database/prisma.service.js';

type Meta = Pick<PrismaService, 'systemMeta'>;

/** Which backup key the vendor holds in escrow (P7-05e), as this PC last sent it. */
export const ESCROWED_KEY = 'backups.escrowed_key';
/** Restore codes the Owner has been told about, to report as seen in the next heartbeat. */
export const RESTORE_CODES_SEEN = 'backups.restore_codes_seen';

const EscrowedKey = z.object({ keyId: z.string(), escrowKeyId: z.string(), at: z.iso.datetime() });
export type EscrowedKey = z.infer<typeof EscrowedKey>;

async function read<T>(prisma: Meta, key: string, schema: z.ZodType<T>): Promise<T | null> {
  const row = await prisma.systemMeta.findUnique({ where: { key } });
  if (row === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function write(prisma: Meta, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await prisma.systemMeta.upsert({
    where: { key },
    create: { key, value: text },
    update: { value: text },
  });
}

export function readEscrowedKey(prisma: Meta): Promise<EscrowedKey | null> {
  return read(prisma, ESCROWED_KEY, EscrowedKey);
}

export function saveEscrowedKey(prisma: Meta, value: EscrowedKey): Promise<void> {
  return write(prisma, ESCROWED_KEY, value);
}

export async function readRestoreCodesSeen(prisma: Meta): Promise<string[]> {
  return (await read(prisma, RESTORE_CODES_SEEN, z.array(z.string()))) ?? [];
}

export function saveRestoreCodesSeen(prisma: Meta, ids: readonly string[]): Promise<void> {
  return write(prisma, RESTORE_CODES_SEEN, ids.slice(-20));
}
