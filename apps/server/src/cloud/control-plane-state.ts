import { ReleaseChannel, ReleaseInfo } from '@rp/contracts/control-plane';
import { z } from 'zod';
import type { PrismaService, TransactionClient } from '../database/prisma.service.js';

type Client = PrismaService | TransactionClient;

const ENROLMENT_KEY = 'control_plane.enrolment';
const OFFERED_UPDATE_KEY = 'control_plane.offered_update';

/** This PC's identity at the Control Plane, saved when it enrolled (ADR-0012). */
export const Enrolment = z.object({
  installationId: z.uuid(),
  tenantId: z.uuid(),
  name: z.string(),
  channel: ReleaseChannel,
  enrolledAt: z.iso.datetime(),
  controlPlaneUrl: z.string(),
});
export type Enrolment = z.infer<typeof Enrolment>;

async function readJson<S extends z.ZodType>(
  prisma: Client,
  key: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  const row = await prisma.systemMeta.findUnique({ where: { key } });
  if (row === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeJson(prisma: Client, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await prisma.systemMeta.upsert({
    where: { key },
    create: { key, value: text },
    update: { value: text },
  });
}

export function readEnrolment(prisma: Client): Promise<Enrolment | undefined> {
  return readJson(prisma, ENROLMENT_KEY, Enrolment);
}

export function saveEnrolment(prisma: Client, enrolment: Enrolment): Promise<void> {
  return writeJson(prisma, ENROLMENT_KEY, enrolment);
}

/** The release the Control Plane last offered (UPD-002), kept across restarts. */
export async function readOfferedUpdate(prisma: Client): Promise<ReleaseInfo | null> {
  return (await readJson(prisma, OFFERED_UPDATE_KEY, ReleaseInfo.nullable())) ?? null;
}

export function saveOfferedUpdate(
  prisma: PrismaService,
  update: ReleaseInfo | null,
): Promise<void> {
  return writeJson(prisma, OFFERED_UPDATE_KEY, update);
}
