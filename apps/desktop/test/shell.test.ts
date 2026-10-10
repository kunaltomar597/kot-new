import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ShellApp,
  type ShellDeps,
  type ShellSession,
  type ShellWindow,
  startShell,
} from '../src/shell.js';

const pem = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const CA = pem('installation-ca.crt');
const SERVER = pem('server.crt');
const OTHER_CA = pem('other-ca.crt');

const CONSOLE = 'https://127.0.0.1:8080/';

/** Stand-ins for Electron's app, session and windows, recording what the shell does. */
class FakeWindow implements ShellWindow {
  readonly loaded: string[] = [];
  destroyed = false;
  minimized = false;
  focused = 0;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
  openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  reloads = 0;
  readonly webContents = {
    on: (event: string, listener: (...args: never[]) => void) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    },
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
      this.openHandler = handler;
    },
    reload: () => {
      this.reloads += 1;
    },
  };

  constructor(readonly options: Parameters<ShellDeps['createWindow']>[0]) {}

  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }
  on(event: 'closed' | 'session-end', listener: () => void): void {
    this.webContents.on(event, listener);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.minimized = false;
  }
  focus(): void {
    this.focused += 1;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
  close(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

function harness(options: { lock?: boolean; serverUpAfter?: number; argv?: string[] } = {}) {
  const logs: string[] = [];
  const pickers = new Map<string, Parameters<ShellSession['onDevicePicker']>[1]>();
  let devicePermission: (() => boolean) | undefined;
  let menuRemoved = false;
  const windows: FakeWindow[] = [];
  const appListeners = new Map<string, () => void>();
  let request: Parameters<ShellSession['setPermissionRequestHandler']>[0] | undefined;
  let check: Parameters<ShellSession['setPermissionCheckHandler']>[0] | undefined;
  let certificate: Parameters<ShellSession['setCertificateVerifyProc']>[0] | undefined;
  let quit = false;
  let loginItem: { openAtLogin: boolean } | undefined;
  let healthCalls = 0;
  const app: ShellApp = {
    requestSingleInstanceLock: () => options.lock ?? true,
    whenReady: () => Promise.resolve(),
    quit: () => {
      quit = true;
    },
    on: (event, listener) => {
      appListeners.set(event, listener);
    },
    setLoginItemSettings: (settings) => {
      loginItem = settings;
    },
  };
  const session: ShellSession = {
    setPermissionRequestHandler: (handler) => {
      request = handler;
    },
    setPermissionCheckHandler: (handler) => {
      check = handler;
    },
    setCertificateVerifyProc: (proc) => {
      certificate = proc;
    },
    setDevicePermissionHandler: (handler) => {
      devicePermission = handler;
    },
    onDevicePicker: (event, listener) => {
      pickers.set(event, listener);
    },
  };
  const deps: ShellDeps = {
    app,
    session: () => session,
    createWindow: (windowOptions) => {
      const window = new FakeWindow(windowOptions);
      windows.push(window);
      return window;
    },
    config: {
      consoleUrl: CONSOLE,
      fullScreen: true,
      openAtLogin: true,
      caFile: 'ca.crt',
      logFile: undefined,
    },
    argv: options.argv ?? [],
    removeMenu: () => {
      menuRemoved = true;
    },
    log: (message) => logs.push(message),
    fetch: () => {
      healthCalls += 1;
      return Promise.resolve(
        new Response('{}', { status: healthCalls > (options.serverUpAfter ?? 0) ? 200 : 503 }),
      );
    },
    readCa: () => CA,
    sleep: () => Promise.resolve(),
    text: { title: 'Restaurant system', starting: 'Starting…' },
  };
  const required = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('The shell did not set it');
    return value;
  };
  return {
    deps,
    windows,
    window: (index = 0) => required(windows[index]),
    appListeners,
    request: () => required(request),
    check: () => required(check),
    certificate: () => required(certificate),
    quit: () => quit,
    loginItem: () => loginItem,
    healthCalls: () => healthCalls,
    logs,
    pickers,
    devicePermission: () => devicePermission,
    menuRemoved: () => menuRemoved,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('[NFR-A04] [SEC-011] the Electron shell', () => {
  it('shows the start-up page until the server answers, then the console, full screen', async () => {
    const h = harness({ serverUpAfter: 3 });
    const shell = await startShell(h.deps);
    expect(shell?.window()).toBe(h.window());
    expect(h.window().options).toMatchObject({
      fullscreen: true,
      webPreferences: { sandbox: true },
    });
    expect(h.window().loaded[0]).toMatch(/^data:text\/html/);
    expect(h.window().loaded[1]).toBe(CONSOLE);
    expect(h.healthCalls()).toBe(4);
    expect(h.loginItem()).toEqual({ openAtLogin: true });
  });

  it('opens the window again when it is closed, but not when the shell quits', async () => {
    const h = harness();
    await startShell(h.deps);
    h.window().close();
    await flush();
    await flush();
    expect(h.windows).toHaveLength(2);
    h.appListeners.get('before-quit')?.();
    h.window(1).close();
    await flush();
    expect(h.windows).toHaveLength(2);
  });

  it('lets Windows sign out or shut down without reopening the window', async () => {
    const h = harness();
    await startShell(h.deps);
    h.window().emit('session-end');
    h.window().close();
    await flush();
    await flush();
    expect(h.windows).toHaveLength(1);
  });

  it('waits for the server again when the console does not load', async () => {
    const h = harness();
    await startShell(h.deps);
    const window = h.window();
    expect(window.loaded).toHaveLength(2);
    // A load the shell replaced itself, or a frame inside the page: nothing to do.
    window.emit('did-fail-load', {}, -3, 'ERR_ABORTED', CONSOLE, true);
    window.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', CONSOLE, false);
    await flush();
    expect(window.loaded).toHaveLength(2);
    // The server went away: the start-up page, then the console once it answers. A second failure
    // while waiting does not start a second wait.
    window.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', CONSOLE, true);
    window.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', CONSOLE, true);
    await flush();
    await flush();
    expect(window.loaded.slice(2)).toEqual([expect.stringMatching(/^data:/), CONSOLE]);
  });

  it('reloads a crashed page, and keeps the console on its own server', async () => {
    const h = harness();
    await startShell(h.deps);
    const window = h.window();
    window.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(window.reloads).toBe(1);
    let prevented = false;
    window.emit(
      'will-navigate',
      { preventDefault: () => (prevented = true) },
      'https://evil.example/',
    );
    expect(prevented).toBe(true);
    prevented = false;
    window.emit('will-navigate', { preventDefault: () => (prevented = true) }, `${CONSOLE}manage`);
    expect(prevented).toBe(false);
    expect(window.openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });

  it('applies the permission and certificate rules to its session', async () => {
    const h = harness();
    await startShell(h.deps);
    const granted: boolean[] = [];
    h.request()({}, 'geolocation', (value) => granted.push(value), { requestingUrl: CONSOLE });
    h.request()({}, 'notifications', (value) => granted.push(value), { requestingUrl: CONSOLE });
    // The camera for a pager's QR code (P2-04b2), never the microphone.
    const media = (mediaTypes: string[]) => {
      h.request()({}, 'media', (value) => granted.push(value), {
        requestingUrl: CONSOLE,
        mediaTypes,
      });
    };
    media(['video']);
    media(['audio']);
    expect(granted).toEqual([false, true, true, false]);
    expect(h.check()({}, 'media', 'https://127.0.0.1:8080', { mediaType: 'video' })).toBe(true);
    expect(h.check()({}, 'media', 'https://127.0.0.1:8080', { mediaType: 'audio' })).toBe(false);
    expect(h.check()({}, 'media', 'https://127.0.0.1:8080', {})).toBe(true);
    expect(h.check()({}, 'media', 'https://example.com', { mediaType: 'video' })).toBe(false);
    const verdicts: number[] = [];
    const verdict = (hostname: string, data: string) => {
      h.certificate()({ hostname, errorCode: -202, certificate: { data } }, (value) =>
        verdicts.push(value),
      );
    };
    verdict('127.0.0.1', SERVER);
    verdict('127.0.0.1', OTHER_CA);
    verdict('example.com', SERVER);
    expect(verdicts).toEqual([0, -2, -3]);
  });

  it('runs once per PC: a second start quits, and brings the first window to the front', async () => {
    const second = harness({ lock: false });
    expect(await startShell(second.deps)).toBeUndefined();
    expect(second.quit()).toBe(true);
    expect(second.windows).toHaveLength(0);

    const first = harness();
    await startShell(first.deps);
    first.window().minimized = true;
    first.appListeners.get('second-instance')?.();
    expect(first.window()).toMatchObject({ minimized: false, focused: 1 });
    first.window().close();
    first.appListeners.get('second-instance')?.();
    expect(first.window().focused).toBe(1);
  });

  it('[SEC-011] [DESKTOP-E2] quits when started with a remote debugging switch', async () => {
    const h = harness({ argv: ['--remote-debugging-port=9222'] });
    expect(await startShell(h.deps)).toBeUndefined();
    expect(h.quit()).toBe(true);
    expect(h.windows).toHaveLength(0);
    expect(h.logs[0]).toContain('--remote-debugging-port=9222');
  });

  it('[SEC-011] [DESKTOP-I3] has no application menu', async () => {
    const h = harness();
    await startShell(h.deps);
    expect(h.menuRemoved()).toBe(true);
  });

  it('[SEC-011] [DESKTOP-E3] refuses every device and cancels the pickers', async () => {
    const h = harness();
    await startShell(h.deps);
    expect(h.devicePermission()?.()).toBe(false);
    for (const picker of ['select-usb-device', 'select-serial-port', 'select-hid-device']) {
      let prevented = false;
      let chosen: string | undefined = 'unset';
      h.pickers.get(picker)?.({ preventDefault: () => (prevented = true) }, (id) => (chosen = id));
      expect([picker, prevented, chosen]).toEqual([picker, true, '']);
    }
    let chosen: string | undefined;
    h.window().emit(
      'select-bluetooth-device',
      { preventDefault: () => undefined },
      [],
      (id: string) => (chosen = id),
    );
    expect(chosen).toBe('');
  });

  it('[SEC-011] [DESKTOP-R2] logs what it refuses, without paths', async () => {
    const h = harness();
    await startShell(h.deps);
    h.request()({}, 'geolocation', () => undefined, { requestingUrl: CONSOLE });
    h.certificate()(
      { hostname: '127.0.0.1', errorCode: -202, certificate: { data: OTHER_CA } },
      () => undefined,
    );
    h.window().emit(
      'will-navigate',
      { preventDefault: () => undefined },
      'https://evil.example/a?token=1',
    );
    h.window().openHandler?.({ url: 'https://evil.example/b?token=2' });
    const text = h.logs.join('\n');
    expect(text).toContain('geolocation');
    expect(text).toContain('certificate of 127.0.0.1');
    expect(text).toContain('Refused to open https://evil.example');
    expect(text).toContain('Refused a new window for https://evil.example');
    expect(text).not.toContain('token');
  });
});
