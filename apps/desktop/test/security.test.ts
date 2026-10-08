import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  healthUrlOf,
  installationFileOf,
  installationSettings,
  shellConfig,
} from '../src/config.js';
import {
  certificateVerdict,
  isAllowedNavigation,
  isAllowedPermission,
  WEB_PREFERENCES,
} from '../src/security.js';
import { waitForServer } from '../src/server-wait.js';
import { splashUrl } from '../src/splash.js';

const CONSOLE = 'https://127.0.0.1:8080/';

/** Test certificates: the installation's CA, the server's certificate it signed, another CA. */
const pem = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const CA = pem('installation-ca.crt');
const SERVER = pem('server.crt');
const OTHER_CA = pem('other-ca.crt');

describe('[SEC-011] the shell’s hardening', () => {
  it('runs the console with context isolation and the sandbox, and no Node.js', () => {
    expect(WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
    expect('preload' in WEB_PREFERENCES).toBe(false);
  });

  it('goes nowhere but the restaurant’s server', () => {
    expect(isAllowedNavigation('https://127.0.0.1:8080/manage/reports', CONSOLE)).toBe(true);
    expect(isAllowedNavigation('https://example.com/', CONSOLE)).toBe(false);
    expect(isAllowedNavigation('http://127.0.0.1:8080/', CONSOLE)).toBe(false);
    expect(isAllowedNavigation('file:///C:/Windows/', CONSOLE)).toBe(false);
    expect(isAllowedNavigation('not a url', CONSOLE)).toBe(false);
  });

  it('trusts the server on this PC by the installation’s CA, and nothing else', () => {
    const local = { hostname: '127.0.0.1', errorCode: -202, certificatePem: SERVER };
    expect(certificateVerdict(local, CA)).toBe(0);
    expect(certificateVerdict({ ...local, hostname: 'localhost' }, CA)).toBe(0);
    // Signed by another CA, or not a certificate: another process on this PC.
    expect(certificateVerdict(local, OTHER_CA)).toBe(-2);
    expect(certificateVerdict({ ...local, certificatePem: OTHER_CA }, CA)).toBe(-2);
    expect(certificateVerdict({ ...local, certificatePem: 'junk' }, CA)).toBe(-2);
    // Any other address, or no CA yet, is left to Chromium's own checks.
    expect(certificateVerdict({ ...local, hostname: 'pos.example.com' }, CA)).toBe(-3);
    expect(certificateVerdict(local, undefined)).toBe(-3);
    expect(certificateVerdict({ ...local, hostname: 'pos.example.com', errorCode: 0 }, CA)).toBe(0);
  });

  it('allows notifications and the camera to the console, nothing else and nobody else', () => {
    expect(isAllowedPermission('notifications', CONSOLE, CONSOLE)).toBe(true);
    expect(isAllowedPermission('media', 'https://127.0.0.1:8080/manage/pagers', CONSOLE)).toBe(
      true,
    );
    expect(isAllowedPermission('geolocation', CONSOLE, CONSOLE)).toBe(false);
    expect(isAllowedPermission('notifications', 'https://example.com/', CONSOLE)).toBe(false);
  });

  it('[PGR-012] gives the console the camera for QR codes, never the microphone', () => {
    expect(isAllowedPermission('media', CONSOLE, CONSOLE, ['video'])).toBe(true);
    expect(isAllowedPermission('media', CONSOLE, CONSOLE, ['audio'])).toBe(false);
    expect(isAllowedPermission('media', CONSOLE, CONSOLE, ['video', 'audio'])).toBe(false);
    expect(isAllowedPermission('media', 'https://example.com/', CONSOLE, ['video'])).toBe(false);
  });
});

describe('[NFR-A04] starting with the PC', () => {
  it('reads the installer’s settings', () => {
    expect(shellConfig({})).toEqual({
      consoleUrl: CONSOLE,
      fullScreen: false,
      openAtLogin: true,
      caFile: undefined,
    });
    expect(
      shellConfig({
        PORT: '8443',
        RP_SHELL_FULLSCREEN: '1',
        RP_SHELL_OPEN_AT_LOGIN: '0',
        RP_DATA_DIR: join('D:', 'RestaurantData'),
      }),
    ).toEqual({
      consoleUrl: 'https://127.0.0.1:8443/',
      fullScreen: true,
      openAtLogin: false,
      caFile: join('D:', 'RestaurantData', 'tls', 'ca.crt'),
    });
    expect(shellConfig({ RP_SHELL_CA_FILE: 'ca.pem', RP_DATA_DIR: 'D:' }).caFile).toBe('ca.pem');
    // On the restaurant PC the installer writes the installation file, not the environment.
    const installed = installationSettings(
      JSON.stringify({ format: 1, dataDir: 'E:\\RestaurantPlatform', server: { port: 9443 } }),
    );
    expect(installed).toEqual({ dataDir: 'E:\\RestaurantPlatform', port: 9443 });
    expect(shellConfig({}, installed)).toMatchObject({
      consoleUrl: 'https://127.0.0.1:9443/',
      caFile: join('E:\\RestaurantPlatform', 'tls', 'ca.crt'),
    });
    expect(shellConfig({ RP_SHELL_PORT: '8081', RP_DATA_DIR: 'D:' }, installed)).toMatchObject({
      consoleUrl: 'https://127.0.0.1:8081/',
      caFile: join('D:', 'tls', 'ca.crt'),
    });
    for (const text of [undefined, '', 'not json', 'null', '[]', '{"server":{"port":"8080"}}']) {
      expect(installationSettings(text)).toEqual({});
    }
    expect(installationSettings('{"dataDir":"","server":{"port":70000}}')).toEqual({});
    expect(installationFileOf({ ProgramData: 'D:\\ProgramData' })).toBe(
      'D:\\ProgramData\\RestaurantPlatform\\installation.json',
    );
    expect(installationFileOf({})).toBe('C:\\ProgramData\\RestaurantPlatform\\installation.json');
    expect(installationFileOf({ RP_INSTALLATION_FILE: 'x.json' })).toBe('x.json');
    expect(() => shellConfig({ RP_SHELL_URL: 'file:///C:/' })).toThrow(/http/);
    expect(healthUrlOf(CONSOLE)).toBe('https://127.0.0.1:8080/api/v1/health');
  });

  it('waits for the server, more slowly the longer it takes', async () => {
    const waits: number[] = [];
    let calls = 0;
    await waitForServer({
      fetch: () => {
        calls += 1;
        if (calls < 5) return Promise.reject(new TypeError('connect ECONNREFUSED'));
        return Promise.resolve(new Response('{}', { status: calls < 6 ? 503 : 200 }));
      },
      healthUrl: 'https://127.0.0.1:8080/api/v1/health',
      intervalMs: 500,
      maxIntervalMs: 5_000,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(calls).toBe(6);
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 5_000]);
  });

  it('shows a start-up page that runs nothing', () => {
    const url = splashUrl('Restaurant <POS>', 'Starting…');
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length));
    expect(html).toContain('Restaurant &lt;POS&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<script');
  });
});
