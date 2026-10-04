import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The service host's state file, `<dataDir>/run/service-host.json` (P0-16b): the PIDs, what it is
 * doing and a heartbeat. The watchdog reads it to tell a busy host (a long restore) from a stuck
 * one; the next host reads it to end a server the last one left behind; support reads it in the
 * diagnostics.
 */

export const HOST_PHASES = [
  'STARTING',
  'WAITING_FOR_DATABASE',
  'RESTORING',
  'MIGRATING',
  'RUNNING',
  'RESTARTING',
  'STOPPING',
  'STOPPED',
] as const;
export type HostPhase = (typeof HOST_PHASES)[number];

const Instant = z.iso.datetime();

export const HostState = z.object({
  format: z.literal(1),
  hostPid: z.int().positive(),
  /** The Node.js the host runs, which also runs the server. */
  execPath: z.string(),
  phase: z.enum(HOST_PHASES),
  phaseSince: Instant,
  /** Written every few seconds while the host works, whatever it is doing. */
  heartbeatAt: Instant,
  serverPid: z.int().positive().nullable(),
  serverStartedAt: Instant.nullable(),
  /** Times the server was started again since the host started. */
  restarts: z.int().nonnegative(),
  lastExit: z
    .object({
      at: Instant,
      code: z.int().nullable(),
      signal: z.string().nullable(),
      /** Why the host ended it (hung, unhealthy), or null when it ended by itself. */
      reason: z.string().nullable(),
    })
    .nullable(),
  /** What last went wrong before the server could start (a migration, say); null when fine. */
  lastError: z.string().nullable(),
});
export type HostState = z.infer<typeof HostState>;

export function hostStatePath(dataDir: string): string {
  return join(dataDir, 'run', 'service-host.json');
}

/** The last state written, or null when there is none or it cannot be read. */
export async function readHostState(path: string): Promise<HostState | null> {
  try {
    const parsed = HostState.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Written beside it, then renamed over it. Windows refuses the rename for a moment while another
 * process reads the file, so it is tried a few times; a heartbeat that still fails is skipped.
 */
export async function writeHostState(path: string, state: HostState): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.new`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(temporary, path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
}
