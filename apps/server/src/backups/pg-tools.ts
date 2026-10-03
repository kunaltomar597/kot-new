import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** A PostgreSQL client program (P7-05): its path, from `RP_PG_BIN` or the PATH. */
export function pgProgram(
  name: 'pg_dump' | 'pg_restore' | 'psql',
  pgBin: string | undefined,
): string {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin === undefined ? file : join(pgBin, file);
}

/**
 * The connection as libpq environment variables, so the password never appears on a command
 * line other local users could read. Prisma's own parameters (`schema=`, `connection_limit=`) are
 * left out; `sslmode` and `host=` (a socket folder) are kept.
 */
export function pgEnvironment(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGCONNECT_TIMEOUT: '10',
  };
  if (url.hostname !== '') env.PGHOST = url.hostname.replace(/^\[|\]$/g, '');
  if (url.port !== '') env.PGPORT = url.port;
  if (url.username !== '') env.PGUSER = decodeURIComponent(url.username);
  if (url.password !== '') env.PGPASSWORD = decodeURIComponent(url.password);
  const host = url.searchParams.get('host');
  if (host !== null) env.PGHOST = host;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null) env.PGSSLMODE = sslmode;
  return env;
}

/** A program that failed, with the end of what it wrote to stderr (no secrets: env only). */
export class PgToolError extends Error {
  constructor(
    readonly program: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${program} failed (${exitCode === null ? 'stopped' : `exit ${String(exitCode)}`}): ${stderr.trim().slice(-400)}`,
    );
    this.name = 'PgToolError';
  }
}

export interface RunningTool {
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Resolves when the program ends successfully; rejects with `PgToolError` otherwise. */
  readonly done: Promise<void>;
}

/** Starts a PostgreSQL program with the connection in its environment. */
export function runPgTool(
  program: string,
  args: readonly string[],
  databaseUrl: string,
): RunningTool {
  const child = spawn(program, args, {
    env: { ...process.env, ...pgEnvironment(databaseUrl) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    stderr = (stderr + text).slice(-4000);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      reject(new PgToolError(program, null, error.message));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new PgToolError(program, code, stderr));
    });
  });
  // A program that stops reading early (pg_restore --list) must not crash the server.
  child.stdin.on('error', () => undefined);
  return { stdin: child.stdin, stdout: child.stdout, done };
}
