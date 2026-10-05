import { join } from 'node:path';
import { PagerFirmwareProblem } from '@rp/contracts';
import { ReleaseInfo, UpdateReport } from '@rp/contracts/control-plane';
import { z } from 'zod';
import type { PrismaService, TransactionClient } from '../database/prisma.service.js';

type Client = PrismaService | TransactionClient;

/**
 * What the PC keeps in `system_meta` about pager firmware (PGR-011, P2-04b): the firmware it
 * serves its pagers, the Control Plane's last word on firmware, a release it refused, and the
 * report for the Control Plane. The images live in `<data>/firmware/pager`.
 */

const SERVED_KEY = 'pager_firmware.served';
const OFFER_KEY = 'control_plane.offered_pager_firmware';
const PROBLEM_KEY = 'pager_firmware.problem';
const REPORT_KEY = 'pager_firmware.report';

const Instant = z.iso.datetime();

/** The firmware the PC checked and serves. */
export const ServedFirmware = z.object({
  version: z.string(),
  sha256: z.string(),
  sizeBytes: z.int().positive(),
  fileName: z.string().regex(/^rp-pager-[0-9A-Za-z.-]{5,64}\.bin$/),
  /** The trusted key that signed it. */
  keyDigest: z.string(),
  acceptedAt: Instant,
});
export type ServedFirmware = z.infer<typeof ServedFirmware>;

/**
 * The Control Plane's last answer about firmware: a release to fetch, and whether the vendor
 * halted the version the PC served when it asked (`forVersion`).
 */
export const OfferedFirmware = z.object({
  update: ReleaseInfo.nullable(),
  halted: z.boolean(),
  forVersion: z.string().nullable().default(null),
});
export type OfferedFirmware = z.infer<typeof OfferedFirmware>;

/**
 * Why the offered release is not served yet. A refused one (it failed a check) is never fetched
 * again; a download problem is tried again at `retryAt`.
 */
export const FirmwareProblem = z.object({
  version: z.string(),
  sha256: z.string(),
  code: PagerFirmwareProblem,
  message: z.string(),
  at: Instant,
  refused: z.boolean(),
  /** Failed downloads in a row. */
  failures: z.int().nonnegative(),
  retryAt: Instant.nullable(),
});
export type FirmwareProblem = z.infer<typeof FirmwareProblem>;

/** Images are named by their version. */
export function firmwareFileName(version: string): string {
  return `rp-pager-${version}.bin`;
}

export const firmwareDir = (dataDir: string) => join(dataDir, 'firmware', 'pager');

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

export function readServedFirmware(prisma: Client): Promise<ServedFirmware | null> {
  return readJson(prisma, SERVED_KEY, ServedFirmware);
}

export function saveServedFirmware(prisma: Client, served: ServedFirmware): Promise<void> {
  return writeJson(prisma, SERVED_KEY, served);
}

export async function readOfferedFirmware(prisma: Client): Promise<OfferedFirmware> {
  return (
    (await readJson(prisma, OFFER_KEY, OfferedFirmware)) ?? {
      update: null,
      halted: false,
      forVersion: null,
    }
  );
}

/** Whether the vendor halted the rollout of the version the PC serves (UPD-003). */
export function isHalted(offer: OfferedFirmware, served: { readonly version: string } | null) {
  return offer.halted && served !== null && offer.forVersion === served.version;
}

export function saveOfferedFirmware(prisma: Client, offer: OfferedFirmware): Promise<void> {
  return writeJson(prisma, OFFER_KEY, offer);
}

export function readFirmwareProblem(prisma: Client): Promise<FirmwareProblem | null> {
  return readJson(prisma, PROBLEM_KEY, FirmwareProblem);
}

export function saveFirmwareProblem(
  prisma: Client,
  problem: FirmwareProblem | null,
): Promise<void> {
  return writeJson(prisma, PROBLEM_KEY, problem);
}

/** For the Control Plane's rollout (UPD-003), sent with each heartbeat until delivered. */
const StoredReport = z.object({ report: UpdateReport, delivered: z.boolean() });

export function saveFirmwareReport(prisma: Client, report: UpdateReport): Promise<void> {
  return writeJson(prisma, REPORT_KEY, { report, delivered: false });
}

/**
 * What the heartbeat says about pager firmware (P2-04b): the version served and the report still
 * to deliver.
 */
export async function firmwareHeartbeat(
  prisma: Client,
): Promise<{ version: string | null; report: UpdateReport | null }> {
  const [served, stored] = await Promise.all([
    readServedFirmware(prisma),
    readJson(prisma, REPORT_KEY, StoredReport),
  ]);
  return {
    version: served?.version ?? null,
    report: stored === null || stored.delivered ? null : stored.report,
  };
}

/** After a heartbeat carrying `report` was answered; a newer report stays to be sent. */
export async function markFirmwareReportDelivered(
  prisma: Client,
  report: UpdateReport,
): Promise<void> {
  const stored = await readJson(prisma, REPORT_KEY, StoredReport);
  if (stored === null || stored.delivered) return;
  if (
    stored.report.version !== report.version ||
    stored.report.outcome !== report.outcome ||
    stored.report.at !== report.at
  ) {
    return;
  }
  await writeJson(prisma, REPORT_KEY, { report, delivered: true });
}
