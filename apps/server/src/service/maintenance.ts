import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The maintenance flag (P0-16b): while the installer or the updater (P7-04c) has the services
 * stopped on purpose, the watchdog leaves them alone. It always expires, so an installer that
 * crashed halfway cannot keep the restaurant's server down for good.
 */

export const MAX_MAINTENANCE_MINUTES = 240;

export const Maintenance = z.object({
  until: z.iso.datetime(),
  reason: z.string().min(1).max(200),
});
export type Maintenance = z.infer<typeof Maintenance>;

export function maintenancePath(dataDir: string): string {
  return join(dataDir, 'run', 'maintenance.json');
}

/** The flag in force at `now`, or null (none, expired or unreadable). */
export async function readMaintenance(path: string, now: Date): Promise<Maintenance | null> {
  try {
    const parsed = Maintenance.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) return null;
    const until = Date.parse(parsed.data.until);
    // A flag further ahead than the maximum was not written by us: it does not count.
    const latest = now.getTime() + MAX_MAINTENANCE_MINUTES * 60_000;
    return until > now.getTime() && until <= latest ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function startMaintenance(
  path: string,
  options: { readonly minutes: number; readonly reason: string; readonly now?: Date },
): Promise<Maintenance> {
  if (!Number.isInteger(options.minutes) || options.minutes < 1) {
    throw new Error('Maintenance lasts at least a minute');
  }
  const minutes = Math.min(options.minutes, MAX_MAINTENANCE_MINUTES);
  const now = options.now ?? new Date();
  const flag = Maintenance.parse({
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
    reason: options.reason,
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, `${JSON.stringify(flag)}\n`);
  await rename(`${path}.new`, path);
  return flag;
}

export async function endMaintenance(path: string): Promise<void> {
  await rm(path, { force: true });
}
