import { UpdateReport } from '@rp/contracts/control-plane';
import { z } from 'zod';
import type { PrismaService, TransactionClient } from '../database/prisma.service.js';

type Client = PrismaService | TransactionClient;

/**
 * What the update agent keeps in `system_meta` (P7-04c). It is in the database, so it survives
 * the restart an update brings; after a rollback the database is the copy from just before the
 * hand-off, which holds the hand-off too.
 */

const AGENT_KEY = 'updates.agent';
const REPORT_KEY = 'updates.report';

const Instant = z.iso.datetime();

export const AgentDownload = z.object({
  version: z.string(),
  fileName: z.string(),
  sha256: z.string(),
  sizeBytes: z.int().positive(),
  status: z.enum(['READY', 'FAILED']),
  /** Why it failed, in plain words. */
  error: z.string().nullable(),
  /** Failed downloads in a row. */
  failures: z.int().nonnegative(),
  retryAt: Instant.nullable(),
  /** The Authenticode signer, when checked (Windows). */
  signer: z.string().nullable(),
});
export type AgentDownload = z.infer<typeof AgentDownload>;

/** The backup or integrity check before an update failed: tried again at `retryAt`. */
export const AgentPreparation = z.object({
  version: z.string(),
  error: z.string(),
  retryAt: Instant,
});
export type AgentPreparation = z.infer<typeof AgentPreparation>;

/** Handed to the updater: waiting for its outcome. */
export const AgentHandoff = z.object({
  requestId: z.string(),
  version: z.string(),
  previousVersion: z.string(),
  at: Instant,
  backupFileName: z.string().nullable(),
});
export type AgentHandoff = z.infer<typeof AgentHandoff>;

export const AgentOutcome = z.object({
  requestId: z.string(),
  version: z.string(),
  previousVersion: z.string().nullable(),
  outcome: z.enum(['INSTALLED', 'ROLLED_BACK', 'FAILED']),
  at: Instant,
  error: z.string().nullable(),
  backupFileName: z.string().nullable(),
});
export type AgentOutcome = z.infer<typeof AgentOutcome>;

export const AgentState = z.object({
  download: AgentDownload.nullable().default(null),
  preparation: AgentPreparation.nullable().default(null),
  handoff: AgentHandoff.nullable().default(null),
  lastOutcome: AgentOutcome.nullable().default(null),
});
export type AgentState = z.infer<typeof AgentState>;

const EMPTY: AgentState = { download: null, preparation: null, handoff: null, lastOutcome: null };

async function readJson<S extends z.ZodType>(
  prisma: Client,
  key: string,
  schema: S,
): Promise<z.output<S> | null> {
  const row = await prisma.systemMeta.findUnique({ where: { key } });
  if (row === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
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

export async function readAgentState(prisma: Client): Promise<AgentState> {
  return (await readJson(prisma, AGENT_KEY, AgentState)) ?? EMPTY;
}

export function saveAgentState(prisma: Client, state: AgentState): Promise<void> {
  return writeJson(prisma, AGENT_KEY, state);
}

/** The install outcome for the Control Plane (UPD-003), sent with each heartbeat until delivered. */
const StoredReport = z.object({ report: UpdateReport, delivered: z.boolean() });

export function saveUpdateReport(prisma: Client, report: UpdateReport): Promise<void> {
  return writeJson(prisma, REPORT_KEY, { report, delivered: false });
}

/** The report a heartbeat still has to carry, or null. */
export async function readUpdateReport(prisma: Client): Promise<UpdateReport | null> {
  const stored = await readJson(prisma, REPORT_KEY, StoredReport);
  return stored === null || stored.delivered ? null : stored.report;
}

/** After a heartbeat carrying `report` was answered; a newer report stays to be sent. */
export async function markUpdateReportDelivered(
  prisma: Client,
  report: UpdateReport,
): Promise<void> {
  const stored = await readJson(prisma, REPORT_KEY, StoredReport);
  if (stored === null || stored.delivered) return;
  if (stored.report.outcome !== report.outcome || stored.report.at !== report.at) return;
  await writeJson(prisma, REPORT_KEY, { report, delivered: true });
}
