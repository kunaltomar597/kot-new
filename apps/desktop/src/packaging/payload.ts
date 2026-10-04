import { join, posix, win32 } from 'node:path';

/**
 * What the installer puts beside the POS window's own files (P0-16d): the layout the server's
 * installation file describes (`installationPaths`, P0-16b), which the set-up scripts (P0-16c)
 * and the services use.
 *
 *   <install>\node\node.exe        Node.js, for the server, the service host and the watchdog
 *   <install>\server\              the server: dist, prisma\migrations, node_modules
 *   <install>\console\             the web console the server serves
 *   <install>\postgres\            PostgreSQL 16: bin, lib, share
 *   <install>\services\            WinSW as RPServer.exe and RPWatchdog.exe
 *   <install>\setup\               the PowerShell set-up scripts
 */
export const INSTALL_FOLDERS = {
  node: 'node',
  server: 'server',
  console: 'console',
  postgres: 'postgres',
  services: 'services',
  setup: 'setup',
} as const;

/** The WinSW copies, one per service (the server's `SERVICE_NAMES`). */
export const SERVICE_EXECUTABLES = ['RPServer.exe', 'RPWatchdog.exe'] as const;

/** The set-up scripts the installer runs (infra/installer/windows), and the module they share. */
export const SETUP_SCRIPTS = [
  'RestaurantPlatform.Setup.psm1',
  'Install-RestaurantPlatform.ps1',
  'Uninstall-RestaurantPlatform.ps1',
  'Get-DataDriveChoice.ps1',
  'Stop-RestaurantPlatform.ps1',
  'Start-RestaurantPlatform.ps1',
] as const;

/** Where the stage step puts everything (`apps/desktop/staging`). */
export interface StagingLayout {
  readonly root: string;
  /** The Electron app electron-builder packs into app.asar. */
  readonly app: string;
  /** The folders copied beside the app (INSTALL_FOLDERS). */
  readonly payload: string;
  /** The build's settings for the NSIS script. */
  readonly nsisDefines: string;
}

export function stagingLayout(root: string): StagingLayout {
  return {
    root,
    app: join(root, 'app'),
    payload: join(root, 'payload'),
    nsisDefines: join(root, 'installer-defines.nsh'),
  };
}

/** The members of EDB's zip that are extracted (under `pgsql/`). */
export const POSTGRES_MEMBERS = [
  'pgsql/bin',
  'pgsql/lib',
  'pgsql/share',
  'pgsql/server_license.txt',
  'pgsql/commandlinetools_3rd_party_licenses.txt',
] as const;

/**
 * Whether a file of EDB's PostgreSQL (its path under `pgsql/`, with `/`) is shipped. The server,
 * its tools and their libraries are; StackBuilder's GUI, the test programs, the embedded-SQL
 * compiler, build files and headers are not.
 */
export function keepPostgresFile(path: string): boolean {
  const [top, ...rest] = path.split('/');
  const name = (rest.at(-1) ?? top ?? '').toLowerCase();
  if (rest.length === 0) return name.endsWith('.txt');
  if (top !== 'bin' && top !== 'lib' && top !== 'share') return false;
  if (name.endsWith('.lib') || name.endsWith('.pdb')) return false;
  if (top === 'lib' && rest[0] === 'pgxs') return false;
  if (top === 'bin') {
    if (/^wx.*\.dll$/.test(name)) return false;
    if (/regress|isolation|test/.test(name)) return false;
    if (['stackbuilder.exe', 'ecpg.exe', 'libpq_pipeline.exe'].includes(name)) return false;
  }
  return true;
}

/** Type declarations and their maps: nothing at run time reads them. */
export function isDeclarationFile(name: string): boolean {
  return /\.d\.[cm]?ts(\.map)?$/.test(name);
}

/**
 * How a zip is unpacked, with only `members` extracted when given: the bsdtar Windows 10 and
 * 11 ship (by its full path, so Git's GNU tar is never picked) and macOS has; `unzip` on Linux.
 */
export function zipExtractCommand(
  platform: NodeJS.Platform,
  zip: string,
  destination: string,
  members: readonly string[] = [],
  systemRoot = 'C:\\Windows',
): { command: string; args: string[] } {
  if (platform === 'linux') {
    return {
      command: 'unzip',
      args: ['-q', '-o', zip, ...members.map((member) => `${member}*`), '-d', destination],
    };
  }
  const command = platform === 'win32' ? win32.join(systemRoot, 'System32', 'tar.exe') : 'tar';
  return { command, args: ['-xf', zip, '-C', destination, ...members] };
}

/** What `setup-cli paths` prints (P0-16c), as far as the check below needs it. */
export interface InstallationPathsJson {
  readonly installDir: string;
  readonly setupCli: string;
  readonly node: string;
  readonly serverDir: string;
  readonly consoleDir: string;
  readonly pgBin: string;
  readonly servicesDir: string;
}

/**
 * The files the services and the set-up scripts run, from the staged server's own idea of the
 * layout (`setup-cli paths` with the payload as its install folder), relative to the payload.
 * Off Windows, the server names Node.js without `.exe`; the payload is always for Windows.
 */
export function requiredPayloadFiles(paths: InstallationPathsJson): string[] {
  const relative = (path: string): string => {
    const normalised = path.replaceAll('\\', '/');
    const root = paths.installDir.replaceAll('\\', '/').replace(/\/$/, '');
    if (!normalised.startsWith(`${root}/`)) {
      throw new Error(`${path} is not in the install folder ${paths.installDir}`);
    }
    return normalised.slice(root.length + 1);
  };
  const node = relative(paths.node);
  return [
    node.endsWith('.exe') ? node : `${node}.exe`,
    relative(paths.setupCli),
    posix.join(relative(paths.serverDir), 'dist', 'main.js'),
    posix.join(relative(paths.serverDir), 'dist', 'service', 'service-host-main.js'),
    posix.join(relative(paths.serverDir), 'dist', 'service', 'watchdog-main.js'),
    posix.join(relative(paths.serverDir), 'dist', 'backups', 'restore-cli.js'),
    posix.join(relative(paths.serverDir), 'dist', 'backups', 'wal-stage.js'),
    posix.join(relative(paths.serverDir), 'prisma', 'migrations', 'migration_lock.toml'),
    posix.join(relative(paths.consoleDir), 'index.html'),
    ...['postgres', 'pg_ctl', 'initdb', 'pg_dump', 'pg_restore', 'pg_basebackup', 'psql'].map(
      (program) => posix.join(relative(paths.pgBin), `${program}.exe`),
    ),
    ...SERVICE_EXECUTABLES.map((name) => posix.join(relative(paths.servicesDir), name)),
    ...SETUP_SCRIPTS.map((name) => posix.join(INSTALL_FOLDERS.setup, name)),
  ];
}
