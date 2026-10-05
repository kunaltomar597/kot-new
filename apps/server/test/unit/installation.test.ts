import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingDefinition } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import {
  databasePassword,
  type DatabasePasswords,
  databaseUrl,
  inheritedEnvironment,
  InstallationFile,
  installationPaths,
  readInstallationFile,
  SERVICE_NAMES,
  programDataDir,
  UPDATER_TASK,
  restoreEnvironment,
  serverEnvironment,
  writeInstallationFile,
} from '../../src/installation/installation.js';
import {
  confValue,
  initdbArgs,
  managedHbaConf,
  managedPostgresSettings,
  pgCtlRegisterArgs,
  withManagedBlock,
} from '../../src/installation/postgres-setup.js';
import {
  DATA_DELETION_MINUTES,
  dataDeletionAllowedUntil,
  dataDeletionPath,
  dataDeletionPermission,
  readDataDeletionPermission,
  saveDataDeletionPermission,
} from '../../src/installation/data-deletion.js';
import { runSetupCli } from '../../src/installation/setup-cli.js';
import { serverServiceXml, watchdogServiceXml, xmlText } from '../../src/installation/winsw.js';
import { restoreRequestPath } from '../../src/service/service-host-main.js';
import {
  updateRollbackOutcomePath,
  updateRollbackRequestPath,
} from '../../src/installation/update-snapshot.js';
import { updateOutcomePath, updateRequestPath } from '../../src/updates/update-files.js';
import { requestPath } from '../../src/backups/pending-restore.js';
import { writeHostState } from '../../src/service/host-state.js';
import { createCertificateAuthority, issueServerCertificate } from '../../src/tls/certificates.js';

const installation: InstallationFile = InstallationFile.parse({
  format: 1,
  installDir: 'C:\\Program Files\\RestaurantPlatform',
  dataDir: 'D:\\RestaurantData',
  productVersion: '1.4.0',
  cloud: { controlPlaneUrl: 'https://cp.example.com' },
});

const passwords: DatabasePasswords = {
  admin: databasePassword(Buffer.alloc(32, 1)),
  migrator: databasePassword(Buffer.alloc(32, 2)),
  server: databasePassword(Buffer.alloc(32, 3)),
  purger: databasePassword(Buffer.alloc(32, 4)),
  backup: databasePassword(Buffer.alloc(32, 5)),
};

describe('[ONB-001] the installation file', () => {
  it('fills in the defaults the installer does not choose', () => {
    expect(installation).toMatchObject({
      secretStore: 'dpapi',
      server: { port: 8080, mqttPort: 8883, logLevel: 'info', tlsHostnames: [] },
      postgres: { port: 5432, database: 'restaurant' },
    });
    expect(() => InstallationFile.parse({ ...installation, extra: 1 })).toThrow();
    expect(() =>
      InstallationFile.parse({ ...installation, cloud: { controlPlaneUrl: 'http://cp' } }),
    ).toThrow();
  });

  it('is written whole and read back, and says what is wrong with a bad one', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rp-install-'));
    const file = join(folder, 'RestaurantPlatform', 'installation.json');
    await writeInstallationFile(file, installation);
    expect(await readInstallationFile(file)).toEqual(installation);
    writeFileSync(file, JSON.stringify({ ...installation, productVersion: '' }));
    await expect(readInstallationFile(file)).rejects.toThrow(/productVersion/);
    await expect(readInstallationFile(join(folder, 'none.json'))).rejects.toThrow(/repair/);
  });
});

describe('[SEC-002] [AUD-004] what the server is given', () => {
  it('gives the server its own login and never the administrator', () => {
    const env = serverEnvironment(installation, passwords);
    expect(env.DATABASE_URL).toBe(
      `postgresql://rp_server:${passwords.server}@127.0.0.1:5432/restaurant`,
    );
    expect(env.RP_PURGE_DATABASE_URL).toContain('rp_purger:');
    expect(env.RP_BACKUP_DATABASE_URL).toMatch(/^postgresql:\/\/rp_backup:.+\/postgres$/);
    expect(JSON.stringify(env)).not.toContain(passwords.admin);
    expect(env).not.toHaveProperty('RP_ADMIN_DATABASE_URL');
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      RP_TLS: 'on',
      RP_SECRET_STORE: 'dpapi',
      RP_PRODUCT_VERSION: '1.4.0',
      RP_CONTROL_PLANE_URL: 'https://cp.example.com',
      RP_DATA_DIR: 'D:\\RestaurantData',
    });
    expect(env).not.toHaveProperty('RP_RELAY_URL');
    expect(restoreEnvironment(installation, passwords).RP_ADMIN_DATABASE_URL).toBe(
      `postgresql://rp_admin:${passwords.admin}@127.0.0.1:5432/postgres`,
    );
  });

  it('is a valid production configuration for the server on Windows', () => {
    const config = loadConfig(serverEnvironment(installation, passwords), 'win32');
    expect(config).toMatchObject({
      nodeEnv: 'production',
      tls: true,
      secretStore: 'dpapi',
      backups: 'on',
      licenceEnforce: true,
    });
    expect(config.adminDatabaseUrl).toBeUndefined();
  });

  it("drops our variables from what a child inherits, keeping the system's", () => {
    expect(
      inheritedEnvironment({
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32',
        RP_ADMIN_DATABASE_URL: 'postgresql://rp_admin:x@127.0.0.1/postgres',
        DATABASE_URL: 'postgresql://x',
        LOG_LEVEL: 'debug',
        PORT: '1',
      }),
    ).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' });
  });

  it('makes passwords a connection string needs no escaping for', () => {
    const password = databasePassword(Buffer.from('ff'.repeat(32), 'hex'));
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(databaseUrl(installation, 'server', passwords)).password).toBe(passwords.server);
  });
});

describe('[DATA-001] [DATA-002] PostgreSQL on the data drive', () => {
  it('listens on this PC only, in UTC, archiving its log for the continuous backup', () => {
    const settings = managedPostgresSettings(installation);
    expect(settings).toMatchObject({
      listen_addresses: 'localhost',
      port: '5432',
      timezone: 'UTC',
      wal_level: 'replica',
      archive_mode: 'on',
      password_encryption: 'scram-sha-256',
    });
    const paths = installationPaths(installation);
    expect(settings.archive_command).toBe(
      [
        `"${paths.node.replaceAll('\\', '/')}"`,
        `"${join(paths.serverDir, 'dist', 'backups', 'wal-stage.js').replaceAll('\\', '/')}"`,
        '"%p" "%f"',
        `"${paths.walStaging.replaceAll('\\', '/')}"`,
      ].join(' '),
    );
    expect(confValue("it's C:\\x")).toBe("'it''s C:\\\\x'");
  });

  it('writes its block once, replacing it on repair', () => {
    const original = 'max_connections = 100\n#port = 5432\n';
    const once = withManagedBlock(original, { port: '5432' });
    const twice = withManagedBlock(once, { port: '5433' });
    expect(twice.match(/BEGIN Restaurant Platform/g)).toHaveLength(1);
    expect(twice).toContain("port = '5433'");
    expect(twice).not.toContain("port = '5432'");
    expect(twice.startsWith(original)).toBe(true);
  });

  it('allows passwords from this PC only, and replication only for the backup login', () => {
    const lines = managedHbaConf()
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines.every((line) => line.endsWith('scram-sha-256'))).toBe(true);
    expect(lines.filter((line) => line.includes('replication'))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('replication')).join()).toContain('rp_backup');
    expect(lines.some((line) => /0\.0\.0\.0|samenet|all\s+trust/.test(line))).toBe(false);
  });

  it('runs initdb with SCRAM, checksums and the password in a file', () => {
    const args = initdbArgs('D:\\RestaurantData\\postgres', 'D:\\RestaurantData\\.pw');
    expect(args).toEqual(
      expect.arrayContaining([
        '--username=rp_admin',
        '--pwfile=D:\\RestaurantData\\.pw',
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '--encoding=UTF8',
        '--data-checksums',
      ]),
    );
  });

  it('[NFR-A04] registers the database service to start at boot', () => {
    expect(pgCtlRegisterArgs(installation)).toEqual([
      'register',
      '-N',
      'RPDatabase',
      '-U',
      'NT AUTHORITY\\NetworkService',
      '-D',
      join('D:\\RestaurantData', 'postgres'),
      '-S',
      'auto',
      '-w',
      '-t',
      '300',
    ]);
  });
});

describe('[ONB-001] [NFR-A04] the Windows service definitions', () => {
  const file = 'C:\\ProgramData\\RestaurantPlatform\\installation.json';

  it('runs the service host at boot after the database, restarting it when it fails', () => {
    const xml = serverServiceXml(installation, file);
    expect(xml).toContain('<id>RPServer</id>');
    expect(xml).toContain('<depend>RPDatabase</depend>');
    expect(xml).toContain('<startmode>Automatic</startmode>');
    expect(xml).toContain('<onfailure action="restart" delay="1 sec"/>');
    expect(xml).toContain(`<executable>${installationPaths(installation).node}</executable>`);
    expect(xml).toContain('service-host-main.js&quot; --installation &quot;C:\\ProgramData');
    expect(xml).toContain(`<logpath>${join('D:\\RestaurantData', 'logs')}</logpath>`);
    expect(xml.split('\r\n')[0]).toBe('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it('runs the watchdog on its own', () => {
    const xml = watchdogServiceXml(installation, file);
    expect(xml).toContain('<id>RPWatchdog</id>');
    expect(xml).toContain('watchdog-main.js');
    expect(xml).not.toContain('<depend>');
  });

  it('escapes what XML needs and refuses a quote in a path', () => {
    expect(xmlText(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    expect(() => serverServiceXml({ ...installation, installDir: 'C:\\Odd"Folder' }, file)).toThrow(
      /double quote/,
    );
  });

  it('keeps the restore request where the System page leaves it', () => {
    expect(restoreRequestPath('D:\\RestaurantData')).toBe(requestPath('D:\\RestaurantData'));
  });
});

describe('[NFR-I02] the set-up tool', () => {
  function output() {
    const lines: string[] = [];
    return { lines, out: { write: (text: string) => lines.push(text) } };
  }

  it('writes the installation file, and repair keeps what it is not told', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rp-setup-'));
    const file = join(folder, 'installation.json');
    const { out } = output();
    expect(
      await runSetupCli(
        [
          'write-installation',
          '--installation',
          file,
          '--install-dir',
          join(folder, 'program'),
          '--data-dir',
          join(folder, 'data'),
          '--product-version',
          '1.0.0',
          '--pg-port',
          '5433',
          '--tls-hostnames',
          'POS.local, back-office',
          '--secret-store',
          'file',
        ],
        {},
        out,
      ),
    ).toBe(0);
    expect(
      await runSetupCli(
        ['write-installation', '--installation', file, '--product-version', '1.1.0'],
        {},
        out,
      ),
    ).toBe(0);
    expect(await readInstallationFile(file)).toMatchObject({
      dataDir: join(folder, 'data'),
      productVersion: '1.1.0',
      secretStore: 'file',
      server: { tlsHostnames: ['pos.local', 'back-office'] },
      postgres: { port: 5433 },
    });
    await expect(
      runSetupCli(['write-installation', '--installation', join(folder, 'new.json')], {}, out),
    ).rejects.toThrow(/installDir/);
  });

  it('makes the secrets, the service files, the maintenance flag and reports status', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rp-setup-'));
    const file = join(folder, 'installation.json');
    await writeInstallationFile(file, {
      ...installation,
      installDir: join(folder, 'program'),
      dataDir: join(folder, 'data'),
      secretStore: 'file',
    });
    const { lines, out } = output();
    const run = (...args: string[]) => runSetupCli([...args, '--installation', file], {}, out);
    expect(await run('secrets')).toBe(0);
    expect(lines.join('')).toContain('Made pin-pepper');
    expect(await run('secrets')).toBe(0);
    expect(lines.at(-1)).toContain('Every secret is there');
    expect(existsSync(join(folder, 'data', 'secrets', 'db-admin-password.key'))).toBe(true);

    expect(await run('service-files')).toBe(0);
    const xml = readFileSync(join(folder, 'program', 'services', 'RPServer.xml'), 'utf8');
    expect(xml).toContain(file);
    expect(existsSync(join(folder, 'program', 'services', 'RPWatchdog.xml'))).toBe(true);

    expect(await run('maintenance', 'on', '--minutes', '10', '--reason', 'update')).toBe(0);
    const now = new Date().toISOString();
    await writeHostState(join(folder, 'data', 'run', 'service-host.json'), {
      format: 1,
      hostPid: 1,
      execPath: process.execPath,
      phase: 'MIGRATING',
      phaseSince: now,
      heartbeatAt: now,
      serverPid: null,
      serverStartedAt: null,
      restarts: 0,
      lastExit: null,
      lastError: null,
    });
    lines.length = 0;
    expect(await run('status')).toBe(0);
    const status = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(status).toMatchObject({
      productVersion: '1.4.0',
      host: { phase: 'MIGRATING' },
      maintenance: { reason: 'update' },
    });
    expect(await run('maintenance', 'off')).toBe(0);
    lines.length = 0;
    await run('status');
    expect(JSON.parse(lines.join(''))).toMatchObject({ maintenance: null });

    expect(await run('postgres-register')).toBe(process.platform === 'win32' ? 0 : 1);
    expect(await run('nonsense')).toBe(2);
    expect(await runSetupCli([], {}, out)).toBe(2);
  });
});

describe('[UPD-007] [UPD-005] the set-up tool and updates', () => {
  it('keeps the signer updates must carry, which the server is given', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rp-setup-'));
    const file = join(folder, 'installation.json');
    const out = { write: () => undefined };
    const base = ['write-installation', '--installation', file];
    expect(
      await runSetupCli(
        [
          ...base,
          '--install-dir',
          join(folder, 'program'),
          '--data-dir',
          join(folder, 'data'),
          '--product-version',
          '1.0.0',
          '--update-publisher',
          'CN=Restaurant Platform Pvt Ltd, C=IN',
          '--allow-unsigned-updates',
          'off',
        ],
        {},
        out,
      ),
    ).toBe(0);
    // Repair without the options keeps them; a test build may allow unsigned installers.
    expect(await runSetupCli([...base, '--product-version', '1.1.0'], {}, out)).toBe(0);
    let written = await readInstallationFile(file);
    expect(written.updates).toEqual({
      publisher: 'CN=Restaurant Platform Pvt Ltd, C=IN',
      allowUnsigned: false,
    });
    expect(serverEnvironment(written, passwords)).toMatchObject({
      RP_UPDATE_PUBLISHER: 'CN=Restaurant Platform Pvt Ltd, C=IN',
    });
    expect(serverEnvironment(written, passwords)).not.toHaveProperty('RP_UPDATE_ALLOW_UNSIGNED');
    expect(await runSetupCli([...base, '--allow-unsigned-updates', 'on'], {}, out)).toBe(0);
    written = await readInstallationFile(file);
    expect(serverEnvironment(written, passwords)).toMatchObject({ RP_UPDATE_ALLOW_UNSIGNED: 'on' });
    await expect(
      runSetupCli([...base, '--allow-unsigned-updates', 'yes'], {}, out),
    ).rejects.toThrow(/on or off/);
    // An installation file from before P7-04c checks nothing and allows nothing.
    expect(InstallationFile.parse({ ...installation, updates: undefined }).updates).toEqual({
      publisher: null,
      allowUnsigned: false,
    });
    expect(installationPaths(written).updatesDir).toBe(join(folder, 'data', 'updates'));
  });

  it('reports the server’s health over TLS with the host’s state', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rp-setup-'));
    const file = join(folder, 'installation.json');
    const dataDir = join(folder, 'data');
    const ca = await createCertificateAuthority();
    const leaf = await issueServerCertificate(ca, { dnsNames: ['localhost'], ipAddresses: [] });
    mkdirSync(join(dataDir, 'tls'), { recursive: true });
    writeFileSync(join(dataDir, 'tls', 'ca.crt'), ca.certificatePem);
    let healthy = true;
    const server = createServer(
      { cert: leaf.certificatePem, key: leaf.privateKeyPem },
      (_request, response) => {
        response.writeHead(healthy ? 200 : 503).end('{}');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await writeInstallationFile(file, {
        ...installation,
        installDir: join(folder, 'program'),
        dataDir,
        secretStore: 'file',
        server: { ...installation.server, port: (server.address() as AddressInfo).port },
      });
      const lines: string[] = [];
      const health = async () => {
        lines.length = 0;
        const code = await runSetupCli(
          ['health', '--installation', file],
          {},
          {
            write: (text) => lines.push(text),
          },
        );
        return { code, report: JSON.parse(lines.join('')) as Record<string, unknown> };
      };
      // The server answers, but its host is not running it yet.
      expect(await health()).toEqual({
        code: 1,
        report: {
          productVersion: '1.4.0',
          health: 'ok',
          phase: null,
          serverPid: null,
          restarts: null,
          lastError: null,
        },
      });
      const now = new Date().toISOString();
      await writeHostState(join(dataDir, 'run', 'service-host.json'), {
        format: 1,
        hostPid: 1,
        execPath: process.execPath,
        phase: 'RUNNING',
        phaseSince: now,
        heartbeatAt: now,
        serverPid: 42,
        serverStartedAt: now,
        restarts: 2,
        lastExit: null,
        lastError: null,
      });
      expect(await health()).toMatchObject({
        code: 0,
        report: { health: 'ok', phase: 'RUNNING', serverPid: 42, restarts: 2 },
      });
      healthy = false;
      expect(await health()).toMatchObject({ code: 1, report: { health: 'degraded' } });
      // Another CA's server is not ours.
      const other = await createCertificateAuthority();
      writeFileSync(join(dataDir, 'tls', 'ca.crt'), other.certificatePem);
      expect(await health()).toMatchObject({ code: 1, report: { health: 'unanswered' } });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const lines: string[] = [];
    expect(
      await runSetupCli(
        ['update-snapshot', 'sideways', '--installation', file],
        {},
        {
          write: (text) => lines.push(text),
        },
      ),
    ).toBe(2);
  });
});

describe('[NFR-I02] the Owner’s permission to delete the data on uninstall', () => {
  const allowedBy = { staffId: 'owner-1', deviceId: 'pos-1' };
  const at = new Date('2026-10-05T10:00:00.000Z');
  const minutes = (count: number) => new Date(at.getTime() + count * 60_000);

  it('holds for half an hour from when the Owner gave it', () => {
    const permission = dataDeletionPermission(allowedBy, at);
    expect(DATA_DELETION_MINUTES).toBe(30);
    expect(permission.until).toBe(minutes(30).toISOString());
    expect(dataDeletionAllowedUntil(permission, minutes(29))).toEqual(minutes(30));
    expect(dataDeletionAllowedUntil(permission, minutes(30))).toBeNull();
    expect(dataDeletionAllowedUntil(null, at)).toBeNull();
  });

  it('ignores a permission the server did not write', () => {
    const permission = dataDeletionPermission(allowedBy, at);
    // Longer than half an hour.
    expect(
      dataDeletionAllowedUntil({ ...permission, until: minutes(24 * 60).toISOString() }, at),
    ).toBeNull();
    // Dated ahead of the clock.
    expect(dataDeletionAllowedUntil(dataDeletionPermission(allowedBy, minutes(5)), at)).toBeNull();
    // Ending before it starts.
    expect(
      dataDeletionAllowedUntil({ ...permission, until: minutes(-1).toISOString() }, at),
    ).toBeNull();
  });

  it('is kept in the data folder’s run folder, and a damaged file is no permission', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rp-deletion-'));
    expect(await readDataDeletionPermission(dataDir)).toBeNull();
    await saveDataDeletionPermission(dataDir, dataDeletionPermission(allowedBy, at));
    expect(dataDeletionPath(dataDir)).toBe(join(dataDir, 'run', 'data-deletion.json'));
    expect(await readDataDeletionPermission(dataDir)).toMatchObject({ allowedBy });
    writeFileSync(dataDeletionPath(dataDir), '{"format":1,');
    expect(await readDataDeletionPermission(dataDir)).toBeNull();
  });

  it('tells the set-up scripts the folders, ports and services, and the permission', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rp-setup-'));
    const file = join(folder, 'installation.json');
    await writeInstallationFile(file, {
      ...installation,
      installDir: join(folder, 'program'),
      dataDir: join(folder, 'data'),
      secretStore: 'file',
    });
    const lines: string[] = [];
    const run = (...args: string[]) =>
      runSetupCli([...args, '--installation', file], {}, { write: (text) => lines.push(text) });
    expect(await run('paths')).toBe(0);
    const paths = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(paths).toMatchObject({
      installationFile: file,
      programDataDir: folder,
      dataDir: join(folder, 'data'),
      setupCli: join(folder, 'program', 'server', 'dist', 'installation', 'setup-cli.js'),
      pgData: join(folder, 'data', 'postgres'),
      secretsDir: join(folder, 'data', 'secrets'),
      tlsDir: join(folder, 'data', 'tls'),
      walStaging: join(folder, 'data', 'backups', 'wal-staging'),
      updatesDir: join(folder, 'data', 'updates'),
      ports: { server: 8080, mqtt: 8883, postgres: 5432 },
      services: { database: 'RPDatabase', server: 'RPServer', watchdog: 'RPWatchdog' },
    });

    lines.length = 0;
    expect(await run('data-deletion')).toBe(3);
    expect(JSON.parse(lines.join(''))).toEqual({ allowed: false, until: null, allowedBy: null });
    const permission = dataDeletionPermission(allowedBy, new Date());
    await saveDataDeletionPermission(join(folder, 'data'), permission);
    lines.length = 0;
    expect(await run('data-deletion')).toBe(0);
    expect(JSON.parse(lines.join(''))).toEqual({
      allowed: true,
      until: permission.until,
      allowedBy: 'owner-1',
    });
  });
});

describe('[ONB-001] [ONB-002] the Windows set-up scripts agree with the server', () => {
  const folder = join(import.meta.dirname, '..', '..', '..', '..', 'infra', 'installer', 'windows');
  const module = readFileSync(join(folder, 'RestaurantPlatform.Setup.psm1'), 'utf8');

  it('name the same services', () => {
    for (const [key, name] of Object.entries(SERVICE_NAMES)) {
      const property = key[0]!.toUpperCase() + key.slice(1);
      expect(module).toMatch(new RegExp(`\\n\\s+${property}\\s+= '${name}'`));
    }
  });

  it('ask for the free space the settings catalogue gives as the default', () => {
    const minimum = settingDefinition('onboarding.minFreeDiskGb')?.defaultValue;
    expect(minimum).toBe(20);
    expect(module).toContain(`$script:DefaultMinFreeGB = ${String(minimum)}`);
    for (const script of ['Install-RestaurantPlatform.ps1', 'Get-DataDriveChoice.ps1']) {
      expect(readFileSync(join(folder, script), 'utf8')).toContain(
        `[int] $MinFreeGB = ${String(minimum)}`,
      );
    }
  });

  it('[UPD-005] hand updates over through the same files and scheduled task', () => {
    const paths = installationPaths({ ...installation, dataDir: 'D:\\Data' });
    expect(paths.updatesDir).toBe(join('D:\\Data', 'updates'));
    // What the server writes, the updater reads there.
    expect(updateRequestPath('D')).toBe(join('D', 'run', 'update-request.json'));
    expect(module).toContain("Join-RPPath $DataDir 'updates'");
    expect(module).toContain("Join-RPPath $dataDir 'run', 'update-request.json'");
    // What the updater writes is in ProgramData, beside the installation file.
    expect(updateOutcomePath('P')).toBe(join('P', 'update-outcome.json'));
    expect(updateRollbackRequestPath('P')).toBe(join('P', 'update-rollback.json'));
    expect(programDataDir(join('P', 'installation.json'))).toBe('P');
    expect(module).toContain("OutcomeFile   = Join-RPPath $root 'update-outcome.json'");
    expect(module).toContain("RollbackFile  = Join-RPPath $root 'update-rollback.json'");
    // What the service host writes, the updater reads.
    expect(updateRollbackOutcomePath('D')).toBe(
      join('D', 'backups', 'update-rollback-outcome.json'),
    );
    expect(module).toContain("Join-RPPath $DataDir 'backups', 'update-rollback-outcome.json'");
    expect(module).toContain(`$script:UpdaterTask = '${UPDATER_TASK}'`);
    expect(module).toContain("'RestaurantPlatform-Setup-{0}.exe' -f $Version");
  });

  it('set permissions on the folders the server uses', () => {
    const paths = installationPaths({ ...installation, dataDir: 'D:\\Data' });
    const relative = (path: string) => path.slice('D:\\Data'.length + 1).split(/[\\/]/);
    for (const path of [paths.pgData, paths.secretsDir, paths.tlsDir, paths.backupsDir]) {
      expect(module).toContain(`Join-RPPath $data '${relative(path).join("', '")}'`);
    }
    expect(module).toContain(`Join-RPPath $data '${relative(paths.walStaging).join("', '")}'`);
  });

  it('call only commands the set-up tool has', async () => {
    const lines: string[] = [];
    await runSetupCli(['help'], {}, { write: (text) => lines.push(text) });
    const usage = lines.join('');
    const called = [...module.matchAll(/-ArgumentList (?:@\()?'([a-z-]+)'/g)].map(
      (match) => match[1]!,
    );
    const commands = [...new Set(called)].filter(
      (name) =>
        !['sidtype', 'failure', 'failureflag', 'start', 'stop', 'delete', 'install'].includes(name),
    );
    expect(commands.sort()).toEqual(
      [
        'data-deletion',
        'database',
        'maintenance',
        'migrate',
        'paths',
        'postgres-init',
        'postgres-register',
        'secrets',
        'service-files',
        'update-snapshot',
      ].sort(),
    );
    for (const command of commands) expect(usage).toMatch(new RegExp(`^${command}\\b`, 'm'));
    // write-installation and status are called with arguments built elsewhere in the module.
    expect(module).toContain("@('write-installation')");
    expect(module).toContain("'status', '--installation'");
    expect(module).toContain("'health', '--installation'");
    expect(usage).toMatch(/^health\b/m);
  });
});
