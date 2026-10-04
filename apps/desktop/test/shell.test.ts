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

function harness(options: { lock?: boolean; serverUpAfter?: number } = {}) {
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
  };
  const deps: ShellDeps = {
    app,
    session: () => session,
    createWindow: (windowOptions) => {
      const window = new FakeWindow(windowOptions);
      windows.push(window);
      return window;
    },
    config: { consoleUrl: CONSOLE, fullScreen: true, openAtLogin: true, caFile: 'ca.crt' },
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
    expect(granted).toEqual([false, true]);
    expect(h.check()({}, 'media', 'https://127.0.0.1:8080')).toBe(true);
    expect(h.check()({}, 'media', 'https://example.com')).toBe(false);
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
});
