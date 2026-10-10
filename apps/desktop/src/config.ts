import { join, win32 } from 'node:path';

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
   * for the server on this PC: `RP_SHELL_CA_FILE`, else `<data folder>/tls/ca.crt`, the data folder
   * being `RP_DATA_DIR` or the installation file's.
   */
  readonly caFile: string | undefined;
  /**
   * Where the shell writes its own events (DESKTOP-R2): `RP_SHELL_LOG_FILE`, else
   * `<data folder>/logs/desktop-shell.log`, where the diagnostics bundle reads the logs from.
   */
  readonly logFile: string | undefined;
}

/**
 * What the shell takes from the installation file the installer writes (P0-16d,
 * `%ProgramData%\RestaurantPlatform\installation.json`, readable by every Windows user): the
 * server's port and the data folder, where the server keeps its CA. The shell starts with Windows
 * for whoever signs in, so it cannot rely on the installer's environment.
 */
export interface InstallationSettings {
  readonly port?: number;
  readonly dataDir?: string;
}

/** The installation file's settings; nothing when it is missing or not what the shell expects. */
export function installationSettings(text: string | undefined): InstallationSettings {
  if (text === undefined) return {};
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof file !== 'object' || file === null) return {};
  const { dataDir, server } = file as { dataDir?: unknown; server?: unknown };
  const port =
    typeof server === 'object' && server !== null ? (server as { port?: unknown }).port : undefined;
  return {
    ...(typeof dataDir === 'string' && dataDir.length > 0 && { dataDir }),
    ...(typeof port === 'number' &&
      Number.isInteger(port) &&
      port > 0 &&
      port < 65_536 && { port }),
  };
}

/** The installation file's usual place (the server's `defaultInstallationFile`). */
export function installationFileOf(env: Readonly<Record<string, string | undefined>>): string {
  return (
    env.RP_INSTALLATION_FILE ??
    win32.join(env.ProgramData ?? 'C:\\ProgramData', 'RestaurantPlatform', 'installation.json')
  );
}

export function shellConfig(
  env: Readonly<Record<string, string | undefined>>,
  installation: InstallationSettings = {},
): ShellConfig {
  const port = env.RP_SHELL_PORT ?? env.PORT ?? String(installation.port ?? 8080);
  const dataDir = env.RP_DATA_DIR ?? installation.dataDir;
  const url = new URL(env.RP_SHELL_URL ?? `https://127.0.0.1:${port}/`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('RP_SHELL_URL must be an http(s) address');
  }
  return {
    consoleUrl: url.href,
    fullScreen: env.RP_SHELL_FULLSCREEN === '1' || env.RP_SHELL_FULLSCREEN === 'true',
    openAtLogin: env.RP_SHELL_OPEN_AT_LOGIN !== '0' && env.RP_SHELL_OPEN_AT_LOGIN !== 'false',
    caFile: env.RP_SHELL_CA_FILE ?? caFileIn(dataDir),
    logFile:
      env.RP_SHELL_LOG_FILE ??
      (dataDir === undefined ? undefined : join(dataDir, 'logs', 'desktop-shell.log')),
  };
}

function caFileIn(dataDir: string | undefined): string | undefined {
  return dataDir === undefined ? undefined : join(dataDir, 'tls', 'ca.crt');
}

/** The server's health endpoint next to the console. */
export function healthUrlOf(consoleUrl: string): string {
  return new URL('/api/v1/health', consoleUrl).href;
}
