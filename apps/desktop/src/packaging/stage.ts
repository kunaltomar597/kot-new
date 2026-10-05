import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import { PRODUCT_NAME } from './builder-config.js';
import { stageAppBuilds } from './app-builds.js';
import { type Component, COMPONENTS, NODE, POSTGRES, WINSW, WINSW_LICENCE } from './components.js';
import { fetchVerified } from './download.js';
import { cloudSettingsFrom, MIN_FREE_GB, nsisDefines, updateSettingsFrom } from './nsis.js';
import {
  INSTALL_FOLDERS,
  type InstallationPathsJson,
  isDeclarationFile,
  keepPostgresFile,
  POSTGRES_MEMBERS,
  requiredPayloadFiles,
  SERVICE_EXECUTABLES,
  SETUP_SCRIPTS,
  stagingLayout,
  zipExtractCommand,
} from './payload.js';
import { collectNotices, noticesText } from './notices.js';
import { pruneUnreachable } from './prune.js';
import { VERSION_MATRIX_FILE, versionMatrix } from './version-matrix.js';

/**
 * The stage step (P0-16d): everything the installer packs, in `apps/desktop/staging`. Run after
 * `pnpm build`; `package-cli` then runs electron-builder on it. The server's `node_modules` are
 * installed for the system the stage step runs on, so an installer for restaurants is staged on
 * Windows (the `windows-latest` CI job); staging elsewhere is for checking the steps.
 */

const run = promisify(execFile);

export interface StageOptions {
  readonly repoRoot: string;
  readonly version: string;
  /** Where downloads are kept between builds (CI caches it). */
  readonly cacheDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The release's phone and tablet APKs (`waiter-app.apk`, `table-tablet.apk`, P7-04e2); without
   * it the installer carries none.
   */
  readonly apkDir?: string;
  readonly log: (message: string) => void;
}

/** What was staged, for the package step and the build's record (`staging/manifest.json`). */
export interface StageManifest {
  readonly productVersion: string;
  /** The system the server's native modules were installed for: `win32` for a real installer. */
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly components: Readonly<Record<Component['id'], string>>;
  readonly cloud: Readonly<Record<string, boolean>>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, relative to it with `/`. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

async function extract(zip: string, destination: string, members: readonly string[]) {
  await mkdir(destination, { recursive: true });
  const { command, args } = zipExtractCommand(
    process.platform,
    zip,
    destination,
    members,
    process.env.SystemRoot,
  );
  await run(command, args, { maxBuffer: 64 * 1024 * 1024 });
}

/** The POS window: its entry point bundled with @rp/i18n into one file, so the app has no node_modules. */
async function stageApp(projectDir: string, appDir: string, version: string) {
  await mkdir(appDir, { recursive: true });
  await bundle({
    entryPoints: [join(projectDir, 'dist', 'main.js')],
    outfile: join(appDir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    legalComments: 'inline',
    logLevel: 'warning',
  });
  const pkg = {
    name: 'restaurant-platform-pos',
    productName: PRODUCT_NAME,
    version,
    description: 'The restaurant PC: POS window, server and database.',
    author: PRODUCT_NAME,
    license: 'UNLICENSED',
    private: true,
    type: 'module',
    main: 'main.js',
  };
  await writeFile(join(appDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

/** The server with its run-time packages only, as real folders (P0-16b's layout). */
async function stageServer(repoRoot: string, serverDir: string, log: StageOptions['log']) {
  await run(
    'pnpm',
    [
      '--filter',
      '@rp/server',
      'deploy',
      '--prod',
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      serverDir,
    ],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' },
  );
  await rm(join(serverDir, 'pnpm-lock.yaml'), { force: true });
  const removed = await pruneUnreachable(serverDir);
  log(`Server: left out ${removed.length} packages nothing loads (optional peers).`);
  for (const file of await filesUnder(serverDir)) {
    if (isDeclarationFile(file)) await rm(join(serverDir, file));
  }
  await writeFile(
    join(serverDir, 'THIRD-PARTY-NOTICES.txt'),
    noticesText(await collectNotices(serverDir)),
  );
}

async function stageNode(zip: string, nodeDir: string, scratch: string) {
  const root = `node-v${NODE.version}-win-x64`;
  const unpacked = join(scratch, 'node');
  await extract(zip, unpacked, [`${root}/node.exe`, `${root}/LICENSE`]);
  await mkdir(nodeDir, { recursive: true });
  await rename(join(unpacked, root, 'node.exe'), join(nodeDir, 'node.exe'));
  await rename(join(unpacked, root, 'LICENSE'), join(nodeDir, 'LICENSE'));
}

async function stagePostgres(zip: string, postgresDir: string, scratch: string) {
  const unpacked = join(scratch, 'postgres');
  await extract(zip, unpacked, POSTGRES_MEMBERS);
  const pgsql = join(unpacked, 'pgsql');
  for (const file of await filesUnder(pgsql)) {
    if (!keepPostgresFile(file)) await rm(join(pgsql, file));
  }
  await rename(pgsql, postgresDir);
}

/** The staged server's own view of the layout: `setup-cli paths` with the payload as install folder. */
async function payloadPaths(payload: string, scratch: string): Promise<InstallationPathsJson> {
  const cli = join(payload, INSTALL_FOLDERS.server, 'dist', 'installation', 'setup-cli.js');
  const installation = join(scratch, 'installation.json');
  const common = ['--installation', installation];
  await run(process.execPath, [
    cli,
    'write-installation',
    '--install-dir',
    payload,
    '--data-dir',
    join(scratch, 'data'),
    '--product-version',
    '0.0.0',
    ...common,
  ]);
  const { stdout } = await run(process.execPath, [cli, 'paths', ...common]);
  return JSON.parse(stdout) as InstallationPathsJson;
}

/**
 * Each program the services start loads with the staged node_modules, and so do the packages the
 * server loads later (on Windows this checks the native modules are Windows' own).
 */
async function checkServerLoads(serverDir: string) {
  for (const entry of [
    'app.factory.js',
    'service/service-host-main.js',
    'service/watchdog-main.js',
    'installation/setup-cli.js',
    'backups/restore-cli.js',
    'backups/wal-stage.js',
  ]) {
    const url = pathToFileURL(join(serverDir, 'dist', entry)).href;
    await run(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(url)})`,
    ]);
  }
  // What the server loads only when it needs it, the native modules among them.
  const lazy = [
    "await import('sharp')",
    "await import('@node-rs/argon2')",
    "await import('@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs')",
    "(await import('node:module')).createRequire(import.meta.url)('pdfmake/fonts/Roboto')",
  ].join(';');
  await run(process.execPath, ['--input-type=module', '-e', lazy], { cwd: serverDir });
}

export async function stage(options: StageOptions): Promise<StageManifest> {
  const { repoRoot, log } = options;
  const projectDir = join(repoRoot, 'apps', 'desktop');
  const layout = stagingLayout(join(projectDir, 'staging'));
  const folder = (name: keyof typeof INSTALL_FOLDERS) =>
    join(layout.payload, INSTALL_FOLDERS[name]);
  const cloud = cloudSettingsFrom(options.env);
  const updates = updateSettingsFrom(options.env);
  if (process.platform !== 'win32') {
    log(`Staging on ${process.platform}: the server's native modules will not run on Windows.`);
  }

  await rm(layout.root, { recursive: true, force: true });
  await mkdir(layout.payload, { recursive: true });
  // Beside the payload, so unpacked files are moved, not copied, on any drive (on the Windows
  // runner the temporary folder is on another drive than the checkout).
  const scratch = join(layout.root, 'scratch');
  await mkdir(scratch);
  try {
    log('Bundling the POS window.');
    await stageApp(projectDir, layout.app, options.version);

    log('Deploying the server with its run-time packages.');
    await stageServer(repoRoot, folder('server'), log);
    await cp(join(repoRoot, 'apps', 'console', 'dist'), folder('console'), { recursive: true });
    const builds = await stageAppBuilds({
      repoRoot,
      release: options.version,
      apkDir: options.apkDir,
      target: folder('apps'),
    });
    log(
      builds.apps.length === 0
        ? 'No phone or tablet APKs given (--apk): the PC will offer none.'
        : `APKs: ${builds.apps.map((app) => `${app.kind} ${app.version}`).join(', ')}.`,
    );

    log('Fetching Node.js, PostgreSQL and WinSW (checked against their pinned SHA-256).');
    const [nodeZip, postgresZip, winsw, winswLicence] = await Promise.all(
      [NODE, POSTGRES, WINSW, WINSW_LICENCE].map((component) =>
        fetchVerified(component, options.cacheDir),
      ),
    );
    if (
      nodeZip === undefined ||
      postgresZip === undefined ||
      winsw === undefined ||
      winswLicence === undefined
    ) {
      throw new Error('A download is missing');
    }
    await stageNode(nodeZip, folder('node'), scratch);
    await stagePostgres(postgresZip, folder('postgres'), scratch);
    await mkdir(folder('services'), { recursive: true });
    for (const name of SERVICE_EXECUTABLES) await cp(winsw, join(folder('services'), name));
    await cp(winswLicence, join(folder('services'), 'WinSW-LICENSE.txt'));

    const scripts = join(repoRoot, 'infra', 'installer', 'windows');
    await mkdir(folder('setup'), { recursive: true });
    for (const name of SETUP_SCRIPTS) await cp(join(scripts, name), join(folder('setup'), name));
    await writeFile(
      layout.nsisDefines,
      nsisDefines({ setupDir: folder('setup'), minFreeGb: MIN_FREE_GB, cloud, updates }),
    );

    log('Checking the payload against the server’s own layout.');
    const required = requiredPayloadFiles(await payloadPaths(layout.payload, scratch));
    const missing: string[] = [];
    for (const file of required) {
      if (!(await exists(join(layout.payload, file)))) missing.push(file);
    }
    if (missing.length > 0) throw new Error(`The payload lacks ${missing.join(', ')}`);
    await checkServerLoads(folder('server'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const manifest: StageManifest = {
    productVersion: options.version,
    platform: process.platform,
    arch: process.arch,
    components: Object.fromEntries(COMPONENTS.map((c) => [c.id, c.version])) as Record<
      Component['id'],
      string
    >,
    cloud: Object.fromEntries(Object.keys(cloud).map((key) => [key, true])),
  };
  await writeFile(join(layout.root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // UPD-006: published with the release, and installed beside the server for support.
  const matrix = `${JSON.stringify(await versionMatrix(options.repoRoot, options.version), null, 2)}\n`;
  await writeFile(join(layout.root, VERSION_MATRIX_FILE), matrix);
  await writeFile(join(layout.payload, VERSION_MATRIX_FILE), matrix);
  return manifest;
}

export async function readManifest(stagingRoot: string): Promise<StageManifest> {
  return JSON.parse(await readFile(join(stagingRoot, 'manifest.json'), 'utf8')) as StageManifest;
}
