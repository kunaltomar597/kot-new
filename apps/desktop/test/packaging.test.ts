import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  AppBuildsFile,
  CLIENT_API_VERSION,
  PAGER_PROTOCOL_VERSION,
  settingDefinition,
} from '@rp/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ID,
  builderConfig,
  ELECTRON_FUSES,
  PRODUCT_NAME,
} from '../src/packaging/builder-config.js';
import { apkFileName, stageAppBuilds } from '../src/packaging/app-builds.js';
import { COMPONENTS, NODE, POSTGRES, WINSW } from '../src/packaging/components.js';
import { cachePathOf, ChecksumError, fetchVerified, sha256Of } from '../src/packaging/download.js';
import { noticesText, packageNotice } from '../src/packaging/notices.js';
import {
  cloudSettingsFrom,
  MIN_FREE_GB,
  nsisDefines,
  nsisString,
  updateSettingsFrom,
} from '../src/packaging/nsis.js';
import {
  INSTALL_FOLDERS,
  isDeclarationFile,
  keepPostgresFile,
  requiredPayloadFiles,
  SETUP_SCRIPTS,
  stagingLayout,
  zipExtractCommand,
} from '../src/packaging/payload.js';
import {
  pruneUnreachable,
  reachablePackages,
  runtimeDependencies,
} from '../src/packaging/prune.js';
import {
  type ReleaseFacts,
  releaseRefusals,
  signedBuild,
  stagedKeys,
  stagedUpdateSettings,
} from '../src/packaging/release-guard.js';
import { VERSION_MATRIX_FILE, versionMatrix } from '../src/packaging/version-matrix.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const projectDir = join(repoRoot, 'apps', 'desktop');

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'rp-packaging-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

describe('[SEC-013] the programs the installer bundles', () => {
  it('are pinned by version and SHA-256, over HTTPS, under licences the policy allows', async () => {
    const policy = JSON.parse(
      await readFile(join(repoRoot, 'infra', 'ci', 'license-policy.json'), 'utf8'),
    ) as { allowed: string[] };
    for (const component of COMPONENTS) {
      expect(new URL(component.url).protocol).toBe('https:');
      expect(component.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(component.url).toContain(component.version);
      expect(policy.allowed).toContain(component.licence);
    }
  });

  it('run the Node.js the project is built for and PostgreSQL 16, the version it is tested on', async () => {
    const nvmrc = (await readFile(join(repoRoot, '.nvmrc'), 'utf8')).trim();
    expect(NODE.version.split('.')[0]).toBe(nvmrc);
    expect(POSTGRES.version.split('.')[0]).toBe('16');
    expect(NODE.url).toMatch(/win-x64\.zip$/);
    expect(POSTGRES.url).toMatch(/windows-x64-binaries\.zip$/);
    expect(WINSW.url).toMatch(/WinSW\.NET461\.exe$/);
  });
});

describe('[SEC-013] downloads', () => {
  const body = 'the program';
  const component = { ...NODE, url: 'https://example.com/dist/program.zip', sha256: sha256(body) };
  const fetchOf = (text: string, calls: string[] = [], status = 200): typeof fetch =>
    ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(status === 200 ? text : null, { status }));
    }) as unknown as typeof fetch;

  it('downloads once, then uses the cached file while it matches', async () => {
    const calls: string[] = [];
    const path = await fetchVerified(component, scratch, fetchOf(body, calls));
    expect(path).toBe(cachePathOf(component, scratch));
    expect(path).toBe(join(scratch, 'program.zip'));
    expect(await readFile(path, 'utf8')).toBe(body);
    await fetchVerified(component, scratch, fetchOf(body, calls));
    expect(calls).toHaveLength(1);
    expect(await sha256Of(path)).toBe(component.sha256);
  });

  it('refuses a download that does not match, leaving nothing behind', async () => {
    const failure = await fetchVerified(component, scratch, fetchOf('something else')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ChecksumError);
    expect((failure as ChecksumError).actual).toBe(sha256('something else'));
    expect((failure as Error).message).toMatch(/not the pinned/);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('downloads again when the cached file was changed', async () => {
    await writeFile(join(scratch, 'program.zip'), 'tampered');
    const calls: string[] = [];
    const path = await fetchVerified(component, scratch, fetchOf(body, calls));
    expect(calls).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(body);
  });

  it('says when the server refuses the download', async () => {
    await expect(fetchVerified(component, scratch, fetchOf('', [], 404))).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('[ONB-001] the payload', () => {
  it('keeps PostgreSQL’s server, tools and libraries, not its GUI, tests or build files', () => {
    for (const kept of [
      'bin/postgres.exe',
      'bin/pg_ctl.exe',
      'bin/initdb.exe',
      'bin/pg_dump.exe',
      'bin/pg_basebackup.exe',
      'bin/libssl-3-x64.dll',
      'bin/icuuc67.dll',
      'lib/plpgsql.dll',
      'share/timezone/Asia/Kolkata',
      'share/postgres.bki',
      'server_license.txt',
    ]) {
      expect(keepPostgresFile(kept), kept).toBe(true);
    }
    for (const dropped of [
      'bin/stackbuilder.exe',
      'bin/wxbase3211u_vc_x64_custom.dll',
      'bin/pg_regress.exe',
      'bin/isolationtester.exe',
      'bin/pg_test_fsync.exe',
      'bin/ecpg.exe',
      'bin/libcurl.lib',
      'lib/libpq.lib',
      'lib/pgxs/src/Makefile.global',
      'include/libpq-fe.h',
      'pgAdmin 4/bin/pgAdmin4.exe',
    ]) {
      expect(keepPostgresFile(dropped), dropped).toBe(false);
    }
  });

  it('leaves out type declarations, which nothing reads at run time', () => {
    expect(isDeclarationFile('dist/index.d.ts')).toBe(true);
    expect(isDeclarationFile('dist/index.d.ts.map')).toBe(true);
    expect(isDeclarationFile('lib/types.d.mts')).toBe(true);
    expect(isDeclarationFile('dist/index.js')).toBe(false);
    expect(isDeclarationFile('dist/index.js.map')).toBe(false);
  });

  it('unpacks zips with Windows’ own tar, macOS’s tar or unzip', () => {
    expect(zipExtractCommand('win32', 'a.zip', 'out', ['pgsql/bin'], 'D:\\Windows')).toEqual({
      command: 'D:\\Windows\\System32\\tar.exe',
      args: ['-xf', 'a.zip', '-C', 'out', 'pgsql/bin'],
    });
    expect(zipExtractCommand('darwin', 'a.zip', 'out')).toEqual({
      command: 'tar',
      args: ['-xf', 'a.zip', '-C', 'out'],
    });
    expect(zipExtractCommand('linux', 'a.zip', 'out', ['pgsql/bin'])).toEqual({
      command: 'unzip',
      args: ['-q', '-o', 'a.zip', 'pgsql/bin*', '-d', 'out'],
    });
  });

  it('[NFR-A04] holds every program the services and the set-up scripts run, where the server looks', () => {
    const install = 'C:\\Program Files\\Restaurant Platform';
    const files = requiredPayloadFiles({
      installDir: install,
      setupCli: `${install}\\server\\dist\\installation\\setup-cli.js`,
      node: `${install}\\node\\node.exe`,
      serverDir: `${install}\\server`,
      consoleDir: `${install}\\console`,
      appsDir: `${install}\\apps`,
      pgBin: `${install}\\postgres\\bin`,
      servicesDir: `${install}\\services`,
    });
    expect(files).toEqual(
      expect.arrayContaining([
        'node/node.exe',
        'server/dist/installation/setup-cli.js',
        'server/dist/service/service-host-main.js',
        'server/dist/service/watchdog-main.js',
        'server/prisma/migrations/migration_lock.toml',
        'console/index.html',
        'apps/apps.json',
        'postgres/bin/pg_ctl.exe',
        'postgres/bin/pg_basebackup.exe',
        'services/RPServer.exe',
        'services/RPWatchdog.exe',
        'setup/Install-RestaurantPlatform.ps1',
        'setup/Stop-RestaurantPlatform.ps1',
      ]),
    );
    // Off Windows the server names Node.js without .exe; the payload is for Windows.
    const offWindows = requiredPayloadFiles({
      installDir: '/stage/payload/',
      setupCli: '/stage/payload/server/dist/installation/setup-cli.js',
      node: '/stage/payload/node/node',
      serverDir: '/stage/payload/server',
      consoleDir: '/stage/payload/console',
      appsDir: '/stage/payload/apps',
      pgBin: '/stage/payload/postgres/bin',
      servicesDir: '/stage/payload/services',
    });
    expect(offWindows[0]).toBe('node/node.exe');
    expect(() =>
      requiredPayloadFiles({
        installDir: 'C:\\RP',
        setupCli: 'C:\\RP\\server\\dist\\installation\\setup-cli.js',
        node: 'C:\\Other\\node.exe',
        serverDir: 'C:\\RP\\server',
        consoleDir: 'C:\\RP\\console',
        appsDir: 'C:\\RP\\apps',
        pgBin: 'C:\\RP\\postgres\\bin',
        servicesDir: 'C:\\RP\\services',
      }),
    ).toThrow(/not in the install folder/);
  });

  it('ships every set-up script, and they are where infra/installer/windows keeps them', async () => {
    const scripts = await readdir(join(repoRoot, 'infra', 'installer', 'windows'));
    for (const name of SETUP_SCRIPTS) expect(scripts).toContain(name);
    const shipped = scripts.filter(
      (name) => /\.ps(m?)1$/.test(name) && name !== 'Invoke-Tests.ps1',
    );
    expect([...SETUP_SCRIPTS].sort()).toEqual(shipped.sort());
  });
});

describe('[ONB-001] trimming the server’s packages', () => {
  async function pkg(dir: string, json: object, licence?: string) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify(json));
    if (licence !== undefined) await writeFile(join(dir, 'LICENSE'), licence);
  }

  it('keeps what the server loads, the nearest copy of each, and drops optional peers', async () => {
    const root = join(scratch, 'server');
    const nm = join(root, 'node_modules');
    await pkg(root, {
      name: '@rp/server',
      dependencies: { a: '1', '@scope/b': '1' },
      optionalDependencies: { 'native-win32': '1', 'native-missing': '1' },
    });
    await pkg(join(nm, 'a'), {
      name: 'a',
      dependencies: { c: '2' },
      peerDependencies: { cli: '*', runtime: '*' },
      peerDependenciesMeta: { cli: { optional: true } },
    });
    await pkg(join(nm, 'a', 'node_modules', 'c'), { name: 'c', version: '2.0.0' });
    await pkg(join(nm, 'c'), { name: 'c', version: '1.0.0' });
    await pkg(join(nm, '@scope', 'b'), { name: '@scope/b' });
    await pkg(join(nm, 'native-win32'), { name: 'native-win32' });
    await pkg(join(nm, 'runtime'), { name: 'runtime' });
    await pkg(join(nm, 'cli'), { name: 'cli', dependencies: { 'cli-only': '1' } });
    await pkg(join(nm, 'cli-only'), { name: 'cli-only' });
    await mkdir(join(nm, '.bin'), { recursive: true });
    await writeFile(join(nm, '.modules.yaml'), 'hoisted');

    const posix = (path: string) => path.split(sep).join('/');
    const reachable = [...(await reachablePackages(root))].map((dir) => posix(relative(root, dir)));
    expect(reachable.sort()).toEqual([
      'node_modules/@scope/b',
      'node_modules/a',
      'node_modules/a/node_modules/c',
      'node_modules/native-win32',
      'node_modules/runtime',
    ]);

    const removed = await pruneUnreachable(root);
    expect(removed.map(posix).sort()).toEqual([
      'node_modules/c',
      'node_modules/cli',
      'node_modules/cli-only',
    ]);
    expect((await readdir(nm)).sort()).toEqual(['@scope', 'a', 'native-win32', 'runtime']);
  });

  it('reads the names a package needs at run time', () => {
    expect(
      runtimeDependencies({
        dependencies: { a: '1' },
        optionalDependencies: { b: '1', a: '1' },
        peerDependencies: { c: '1', d: '1' },
        peerDependenciesMeta: { d: { optional: true } },
      }),
    ).toEqual(['a', 'b', 'c']);
  });

  it('lists every package with its licence text in the third-party notices', async () => {
    const dir = join(scratch, 'x');
    await pkg(dir, { name: 'x', version: '1.2.3', license: 'MIT' }, 'MIT licence text');
    const sharp = join(scratch, 'sharp');
    await pkg(sharp, { name: '@img/sharp-win32-x64', version: '0.35.4', license: 'LGPL-3.0' });
    const old = join(scratch, 'old');
    await pkg(old, { name: 'old', version: '0.1.0', licenses: [{ type: 'BSD' }] });

    const notices = await Promise.all([dir, sharp, old].map(packageNotice));
    expect(notices[0]).toEqual({
      name: 'x',
      version: '1.2.3',
      licence: 'MIT',
      text: 'MIT licence text',
    });
    expect(notices[2]?.licence).toBe('BSD');
    const text = noticesText(notices);
    expect(text.indexOf('@img/sharp-win32-x64 0.35.4')).toBeLessThan(text.indexOf('old 0.1.0'));
    expect(text).toContain('Licence: LGPL-3.0');
    expect(text).toContain('https://github.com/libvips/libvips');
    expect(text).toContain('MIT licence text');
    expect(text).toContain('carries no licence file');
  });
});

describe('[ONB-002] the installer script’s settings', () => {
  it('asks for the free space the settings catalogue gives as the default', () => {
    expect(settingDefinition('onboarding.minFreeDiskGb')?.defaultValue).toBe(MIN_FREE_GB);
  });

  it('carries the vendor’s https addresses, and nothing it is not given', () => {
    expect(
      cloudSettingsFrom({
        RP_CONTROL_PLANE_URL: 'https://cp.example.in',
        RP_RELAY_URL: ' ',
        RP_ERROR_DSN: 'https://key@errors.example.in/2',
      }),
    ).toEqual({
      controlPlaneUrl: 'https://cp.example.in',
      errorDsn: 'https://key@errors.example.in/2',
    });
    expect(() => cloudSettingsFrom({ RP_RELAY_URL: 'http://relay.example.in' })).toThrow(/https/);
    expect(() => cloudSettingsFrom({ RP_QR_SITE_URL: 'menu' })).toThrow(/not an address/);
  });

  it('[UPD-007] names the signer updates must carry, or allows unsigned ones on a test build only', () => {
    expect(updateSettingsFrom({})).toEqual({ allowUnsigned: false });
    expect(updateSettingsFrom({ RP_ALLOW_UNSIGNED_UPDATES: '1' })).toEqual({ allowUnsigned: true });
    expect(
      updateSettingsFrom({
        RP_UPDATE_PUBLISHER: ' CN=Restaurant Platform Pvt Ltd, C=IN ',
        RP_UPDATE_ISSUER: ' CN=Vendor CA, O=Some CA, C=US ',
      }),
    ).toEqual({
      publisher: 'CN=Restaurant Platform Pvt Ltd, C=IN',
      issuer: 'CN=Vendor CA, O=Some CA, C=US',
      allowUnsigned: false,
    });
    // [UPDATE-S2] a publisher without its issuer would pin the name alone.
    expect(() => updateSettingsFrom({ RP_UPDATE_PUBLISHER: 'CN=Restaurant Platform' })).toThrow(
      /RP_UPDATE_ISSUER/,
    );
    expect(() =>
      updateSettingsFrom({ RP_UPDATE_PUBLISHER: 'CN=Vendor', RP_ALLOW_UNSIGNED_UPDATES: '1' }),
    ).toThrow(/never accepts unsigned updates/);
    expect(() => updateSettingsFrom({ RP_UPDATE_PUBLISHER: 'CN' })).toThrow(/certificate subject/);
    expect(
      nsisDefines({
        setupDir: 'x',
        minFreeGb: 20,
        cloud: {},
        updates: {
          publisher: 'CN=Vendor "Ltd" $1',
          issuer: 'CN=CA $2',
          allowUnsigned: false,
        },
      }),
    ).toContain(
      '!define RP_UPDATE_PUBLISHER "CN=Vendor $\\"Ltd$\\" $$1"\n!define RP_UPDATE_ISSUER "CN=CA $$2"',
    );
    const test = nsisDefines({
      setupDir: 'x',
      minFreeGb: 20,
      cloud: {},
      updates: { allowUnsigned: true },
    });
    expect(test).toContain('!define RP_ALLOW_UNSIGNED_UPDATES\n');
    expect(test).not.toContain('RP_UPDATE_PUBLISHER');
  });

  it('writes NSIS defines, escaping what NSIS would read as variables or quotes', () => {
    expect(nsisString('a$b"c')).toBe('a$$b$\\"c');
    expect(() => nsisString('a\nb')).toThrow(/line break/);
    expect(
      nsisDefines({
        setupDir: 'D:\\a\\staging\\payload\\setup',
        minFreeGb: 20,
        cloud: { controlPlaneUrl: 'https://cp.example.in' },
      }),
    ).toBe(
      [
        '; Written by the stage step (apps/desktop/src/packaging); do not edit.',
        '!define RP_SETUP_DIR "D:\\a\\staging\\payload\\setup"',
        '!define RP_MIN_FREE_GB 20',
        '!define RP_CONTROL_PLANE_URL "https://cp.example.in"',
        '',
      ].join('\n'),
    );
    expect(() => nsisDefines({ setupDir: 'x', minFreeGb: 0, cloud: {} })).toThrow(/whole number/);
  });

  it('uses only the defines the stage step writes, and runs every script it needs', async () => {
    const bytes = await readFile(join(projectDir, 'installer', 'installer.nsh'));
    // ASCII only, like the PowerShell: NSIS reads a file without a byte order mark as ANSI.
    const printable = (byte: number) =>
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127);
    expect(bytes.every(printable)).toBe(true);
    const script = bytes.toString('latin1');
    const used = new Set([...script.matchAll(/\$\{(RP_[A-Z_]+)\}/g)].map((match) => match[1]));
    const defined = new Set([
      ...[...script.matchAll(/!define (RP_[A-Z_]+)/g)].map((match) => match[1]),
      ...[
        ...nsisDefines({
          setupDir: 'x',
          minFreeGb: 1,
          cloud: {
            controlPlaneUrl: 'https://a.in',
            relayUrl: 'https://b.in',
            qrSiteUrl: 'https://c.in',
            errorDsn: 'https://d.in',
          },
          updates: { publisher: 'CN=Vendor', issuer: 'CN=CA', allowUnsigned: false },
        }).matchAll(/!define (RP_[A-Z_]+)/g),
        ...nsisDefines({
          setupDir: 'x',
          minFreeGb: 1,
          cloud: {},
          updates: { allowUnsigned: true },
        }).matchAll(/!define (RP_[A-Z_]+)/g),
      ].map((match) => match[1]),
    ]);
    for (const name of used) expect(defined, name).toContain(name);
    for (const name of [
      'Install-RestaurantPlatform.ps1',
      'Uninstall-RestaurantPlatform.ps1',
      'Get-DataDriveChoice.ps1',
      'Stop-RestaurantPlatform.ps1',
      'Start-RestaurantPlatform.ps1',
      'RestaurantPlatform.Setup.psm1',
    ]) {
      expect(script).toContain(name);
    }
    // Every define the script tests for is one the stage step may write.
    const tested = [...script.matchAll(/!ifn?def (RP_[A-Z_]+)/g)].map((match) => match[1]);
    for (const name of tested) expect(defined, name).toContain(name);
    // P7-04c: the install step keeps this installer to go back to after a failed update.
    expect(script).toContain('-InstallerPath "$EXEPATH"');
    expect(script).toContain('!include "${PROJECT_DIR}\\staging\\installer-defines.nsh"');
    // No "/" in the paths makensis reads on Windows.
    expect(script).not.toMatch(/^\s*(!include|File) "[^"]*\//m);
    expect(stagingLayout('/s').nsisDefines).toBe(join('/s', 'installer-defines.nsh'));
  });
});

describe('[SEC-011] [ONB-001] the installer', () => {
  const config = builderConfig({
    projectDir: '/repo/apps/desktop',
    staging: stagingLayout('/repo/apps/desktop/staging'),
    outputDir: '/repo/apps/desktop/release',
    version: '1.4.0',
    electronVersion: '44.5.1',
    editExecutable: true,
  });

  it('sets Electron’s fuses: no Node.js mode, options or debugger, and only its checked app.asar', () => {
    expect(config.electronFuses).toEqual(ELECTRON_FUSES);
    expect(ELECTRON_FUSES).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
    expect(config.asar).toBe(true);
  });

  it('installs for every user of the PC with administrator rights, keeping the data on uninstall', () => {
    expect(config.appId).toBe(APP_ID);
    expect(config.productName).toBe(PRODUCT_NAME);
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: true,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
      warningsAsErrors: true,
      include: join('/repo/apps/desktop', 'installer', 'installer.nsh'),
    });
    expect(config.win).toMatchObject({
      target: [{ target: 'nsis', arch: ['x64'] }],
      signAndEditExecutable: true,
    });
    expect(config.extraMetadata).toEqual({ version: '1.4.0' });
    expect(config.publish).toBeNull();
  });

  it('puts the server’s programs beside the POS window, where the services look for them', async () => {
    // One set from the payload's root, so the server's node_modules is not that set's root (which
    // electron-builder drops).
    expect(config.extraFiles).toEqual([
      {
        from: '/repo/apps/desktop/staging/payload',
        to: '.',
        filter: Object.values(INSTALL_FOLDERS).map((folder) => `${folder}/**/*`),
      },
    ]);
    expect(config.directories?.app).toBe(join('/repo/apps/desktop/staging', 'app'));
    expect(config.files).toEqual(['main.js', 'package.json']);
    // node_modules are handled outside electron-builder: the app is one bundled file.
    const beforeBuild = config.beforeBuild as () => Promise<boolean>;
    expect(await beforeBuild()).toBe(false);
  });
});

describe('[UPD-006] the component version matrix of each release', () => {
  it('lists what the installer contains, the client API it serves and each app', async () => {
    const matrix = await versionMatrix(repoRoot, '1.2.3');
    const versionOf = async (app: string) =>
      (
        JSON.parse(await readFile(join(repoRoot, 'apps', app, 'package.json'), 'utf8')) as {
          version: string;
        }
      ).version;
    expect(matrix.release).toBe('1.2.3');
    expect(matrix.clientApi.current).toBe(CLIENT_API_VERSION);
    expect(Object.fromEntries(matrix.components.map((part) => [part.name, part.version]))).toEqual({
      server: await versionOf('server'),
      console: await versionOf('console'),
      desktop: '1.2.3',
      node: NODE.version,
      postgres: POSTGRES.version,
      winsw: WINSW.version,
    });
    expect(matrix.clients.map((client) => [client.kind, client.version])).toEqual([
      ['console', await versionOf('console')],
      ['waiter-app', await versionOf('waiter-app')],
      ['table-tablet', await versionOf('table-tablet')],
    ]);
    expect(matrix.pagerProtocol).toBe(PAGER_PROTOCOL_VERSION);
    expect(VERSION_MATRIX_FILE).toBe('version-matrix.json');
  });
});

describe('[WTR-001] [UPD-007] the phone and tablet APKs in the installer (P7-04e2)', () => {
  const versionOf = async (app: string) =>
    (
      JSON.parse(await readFile(join(repoRoot, 'apps', app, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;

  it('copies each APK under its version, with its size and SHA-256 in apps.json', async () => {
    const apkDir = join(scratch, 'apks');
    await mkdir(apkDir);
    await writeFile(join(apkDir, apkFileName('waiter-app')), 'waiter apk');
    await writeFile(join(apkDir, apkFileName('table-tablet')), 'tablet apk!');
    const target = join(scratch, 'payload', 'apps');
    const manifest = await stageAppBuilds({ repoRoot, release: '2.3.0', apkDir, target });
    const waiter = await versionOf('waiter-app');
    expect(manifest.apps).toEqual([
      {
        kind: 'waiter-app',
        version: waiter,
        clientApi: CLIENT_API_VERSION,
        file: `waiter-app-${waiter}.apk`,
        sha256: sha256('waiter apk'),
        sizeBytes: 10,
      },
      expect.objectContaining({
        kind: 'table-tablet',
        sha256: sha256('tablet apk!'),
        sizeBytes: 11,
      }),
    ]);
    const written = AppBuildsFile.parse(
      JSON.parse(await readFile(join(target, 'apps.json'), 'utf8')),
    );
    expect(written).toEqual(manifest);
    expect(await readFile(join(target, `waiter-app-${waiter}.apk`), 'utf8')).toBe('waiter apk');
  });

  it('lists none without APKs, takes one app alone, and refuses anything else', async () => {
    const none = await stageAppBuilds({
      repoRoot,
      release: '2.3.0',
      apkDir: undefined,
      target: join(scratch, 'none'),
    });
    expect(none.apps).toEqual([]);
    expect(await readFile(join(scratch, 'none', 'apps.json'), 'utf8')).toContain('"apps": []');

    const one = join(scratch, 'one');
    await mkdir(one);
    await writeFile(join(one, 'table-tablet.apk'), 'tablet');
    const tabletOnly = await stageAppBuilds({
      repoRoot,
      release: '2.3.0',
      apkDir: one,
      target: join(scratch, 'one-out'),
    });
    expect(tabletOnly.apps.map((app) => app.kind)).toEqual(['table-tablet']);

    const odd = join(scratch, 'odd');
    await mkdir(odd);
    await writeFile(join(odd, 'app-release.apk'), 'x');
    await expect(
      stageAppBuilds({ repoRoot, release: '2.3.0', apkDir: odd, target: join(scratch, 'o') }),
    ).rejects.toThrow(/Unknown APKs/);
    const empty = join(scratch, 'empty');
    await mkdir(empty);
    await expect(
      stageAppBuilds({ repoRoot, release: '2.3.0', apkDir: empty, target: join(scratch, 'e') }),
    ).rejects.toThrow(/No APKs/);
  });
});

describe('[UPD-007] [LIC-003] [PGR-011] the release guard (P8-03b3b)', () => {
  const licenceKey = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
  const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
  const release: ReleaseFacts = {
    signed: true,
    updates: { publisher: true, issuer: true, allowUnsigned: false },
    stagedOn: 'win32',
    anyPlatform: false,
    keys: { licence: [licenceKey], pagerFirmware: [sha256('pager key')] },
  };
  const test: ReleaseFacts = {
    signed: false,
    updates: { publisher: false, issuer: false, allowUnsigned: true },
    stagedOn: 'win32',
    anyPlatform: false,
    keys: { licence: [], pagerFirmware: [] },
  };

  it('builds a release with all it needs, and a test installer without them', () => {
    expect(releaseRefusals(release)).toEqual([]);
    expect(releaseRefusals(test)).toEqual([]);
    expect(
      releaseRefusals({
        ...test,
        updates: { publisher: false, issuer: false, allowUnsigned: false },
      }),
    ).toEqual([]);
    expect(releaseRefusals({ ...test, stagedOn: 'darwin', anyPlatform: true })).toEqual([]);
    expect(releaseRefusals({ ...test, stagedOn: 'darwin' })).toEqual([
      expect.stringMatching(/staged on darwin; stage it on Windows, or pass --any-platform/),
    ]);
  });

  it('refuses a signed build that takes unsigned updates or names no signer', () => {
    expect(
      releaseRefusals({
        ...release,
        updates: { publisher: true, issuer: true, allowUnsigned: true },
      }),
    ).toEqual([expect.stringMatching(/cannot accept unsigned updates/)]);
    expect(
      releaseRefusals({
        ...release,
        updates: { publisher: false, issuer: false, allowUnsigned: false },
      }),
    ).toEqual([expect.stringMatching(/RP_UPDATE_PUBLISHER/)]);
  });

  it('[UPDATE-S2] refuses a signed build that names a signer but not its issuer', () => {
    expect(
      releaseRefusals({
        ...release,
        updates: { publisher: true, issuer: false, allowUnsigned: false },
      }),
    ).toEqual([expect.stringMatching(/RP_UPDATE_ISSUER/)]);
  });

  it('refuses a signed build without the vendor’s licence key or pager firmware key', () => {
    expect(releaseRefusals({ ...release, keys: { licence: [], pagerFirmware: [] } })).toEqual([
      expect.stringMatching(
        /licence key in packages\/licensing\/src\/vendor-keys\.ts \(manual task 23\)/,
      ),
      expect.stringMatching(/pager firmware key’s digest .* \(manual task 30\)/),
    ]);
    const bad = (keys: Partial<ReleaseFacts['keys']>) =>
      releaseRefusals({ ...release, keys: { ...release.keys, ...keys } });
    expect(bad({ licence: [rsaKey] })).toEqual([
      expect.stringMatching(/not an Ed25519 public key/),
    ]);
    expect(bad({ licence: ['not a key!'] })).toEqual([expect.stringMatching(/not an Ed25519/)]);
    expect(bad({ pagerFirmware: [sha256('a').toUpperCase()] })).toEqual([
      expect.stringMatching(/lower-case hex/),
    ]);
    expect(bad({ pagerFirmware: ['a', 'b', 'c', 'd'].map(sha256) })).toEqual([
      expect.stringMatching(/at most 3/),
    ]);
    expect(bad({ pagerFirmware: ['a', 'b', 'c'].map(sha256) })).toEqual([]);
  });

  it('refuses a signed build staged off Windows, even as a test of the script', () => {
    expect(releaseRefusals({ ...release, stagedOn: 'darwin', anyPlatform: true })).toEqual([
      expect.stringMatching(/a signed installer is staged on Windows/),
    ]);
  });

  it('counts a build as signed as electron-builder does: WIN_CSC_LINK when set, else CSC_LINK', () => {
    expect(signedBuild({})).toBe(false);
    expect(signedBuild({ WIN_CSC_LINK: '', CSC_LINK: '' })).toBe(false);
    expect(signedBuild({ WIN_CSC_LINK: 'MIIK...' })).toBe(true);
    expect(signedBuild({ CSC_LINK: 'C:\\certs\\vendor.p12' })).toBe(true);
    // An empty WIN_CSC_LINK wins over CSC_LINK, as in electron-builder.
    expect(signedBuild({ WIN_CSC_LINK: '', CSC_LINK: 'MIIK...' })).toBe(false);
  });

  it('reads the update settings and the keys the staged installer carries', async () => {
    const defines = (updates: { publisher?: string; issuer?: string; allowUnsigned: boolean }) =>
      stagedUpdateSettings(nsisDefines({ setupDir: 'x', minFreeGb: 20, cloud: {}, updates }));
    expect(defines({ publisher: 'CN=Vendor', issuer: 'CN=CA', allowUnsigned: false })).toEqual({
      publisher: true,
      issuer: true,
      allowUnsigned: false,
    });
    expect(defines({ allowUnsigned: true })).toEqual({
      publisher: false,
      issuer: false,
      allowUnsigned: true,
    });
    expect(defines({ allowUnsigned: false })).toEqual({
      publisher: false,
      issuer: false,
      allowUnsigned: false,
    });

    // A staged server as the stage step deploys it: its dist, and @rp/licensing in node_modules.
    const payloadWith = async (name: string, firmwareKeys: string) => {
      const server = join(scratch, name, INSTALL_FOLDERS.server);
      const licensing = join(server, 'node_modules', '@rp', 'licensing');
      const firmware = join(server, 'dist', 'pager-firmware');
      await mkdir(join(licensing, 'dist'), { recursive: true });
      await mkdir(firmware, { recursive: true });
      await writeFile(join(server, 'package.json'), '{"type":"module"}');
      await writeFile(join(licensing, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(licensing, 'dist', 'vendor-keys.js'),
        `export const VENDOR_LICENCE_KEYS = [${JSON.stringify(licenceKey)}];\n`,
      );
      await writeFile(join(firmware, 'firmware-keys.js'), firmwareKeys);
      return join(scratch, name);
    };
    expect(
      await stagedKeys(
        await payloadWith(
          'payload',
          `export const PAGER_FIRMWARE_KEY_DIGESTS = [${JSON.stringify(sha256('k'))}];\n`,
        ),
      ),
    ).toEqual({ licence: [licenceKey], pagerFirmware: [sha256('k')] });
    await expect(
      stagedKeys(await payloadWith('renamed', 'export const OTHER = [];\n')),
    ).rejects.toThrow(/no list PAGER_FIRMWARE_KEY_DIGESTS/);
    await expect(stagedKeys(join(scratch, 'nothing'))).rejects.toThrow();
  });
});
