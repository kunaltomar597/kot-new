import { join } from 'node:path';

/** Where the shell finds the console, from the installer's settings (`RP_SHELL_*`). */
export interface ShellConfig {
  /** The console on this PC's server, e.g. `https://127.0.0.1:8080/`. */
  readonly consoleUrl: string;
  /** Full screen for a touch POS; a window for a manager's PC. */
  readonly fullScreen: boolean;
  /** Starts with Windows (NFR-A04: the POS window reopens by itself). */
  readonly openAtLogin: boolean;
  /**
   * The installation's CA certificate that the server writes at its first start (ADR-0011), pinned
   * for the server on this PC: `RP_SHELL_CA_FILE`, else `<RP_DATA_DIR>/tls/ca.crt`.
   */
  readonly caFile: string | undefined;
}

export function shellConfig(env: Readonly<Record<string, string | undefined>>): ShellConfig {
  const port = env.RP_SHELL_PORT ?? env.PORT ?? '8080';
  const url = new URL(env.RP_SHELL_URL ?? `https://127.0.0.1:${port}/`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('RP_SHELL_URL must be an http(s) address');
  }
  return {
    consoleUrl: url.href,
    fullScreen: env.RP_SHELL_FULLSCREEN === '1' || env.RP_SHELL_FULLSCREEN === 'true',
    openAtLogin: env.RP_SHELL_OPEN_AT_LOGIN !== '0' && env.RP_SHELL_OPEN_AT_LOGIN !== 'false',
    caFile:
      env.RP_SHELL_CA_FILE ??
      (env.RP_DATA_DIR === undefined ? undefined : join(env.RP_DATA_DIR, 'tls', 'ca.crt')),
  };
}

/** The server's health endpoint next to the console. */
export function healthUrlOf(consoleUrl: string): string {
  return new URL('/api/v1/health', consoleUrl).href;
}
