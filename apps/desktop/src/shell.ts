import { healthUrlOf, type ShellConfig } from './config.js';
import {
  certificateVerdict,
  isAllowedNavigation,
  isAllowedPermission,
  WEB_PREFERENCES,
} from './security.js';
import { waitForServer } from './server-wait.js';
import { splashUrl } from './splash.js';

/**
 * The Electron shell (C4, P0-16a): one window with the console from this PC's server, hardened
 * (SEC-011), that starts with Windows and comes back when it is closed or its page crashes
 * (NFR-A04). The parts of Electron it uses are passed in, so it is tested without Electron.
 */

type Listener = (...args: never[]) => void;

export interface ShellWebContents {
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string }) => void,
  ): void;
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ) => void,
  ): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  reload(): void;
}

export interface ShellWindow {
  readonly webContents: ShellWebContents;
  loadURL(url: string): Promise<void>;
  on(event: 'closed' | 'session-end', listener: () => void): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export interface ShellSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl: string; mediaTypes?: readonly string[] },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: { mediaType?: string },
    ) => boolean,
  ): void;
  setCertificateVerifyProc(
    proc: (
      request: { hostname: string; errorCode: number; certificate: { data: string } },
      callback: (verdict: number) => void,
    ) => void,
  ): void;
}

export interface ShellApp {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<unknown>;
  quit(): void;
  on(event: 'second-instance' | 'before-quit' | 'window-all-closed', listener: Listener): unknown;
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export interface ShellDeps {
  readonly app: ShellApp;
  readonly session: () => ShellSession;
  readonly createWindow: (options: {
    readonly fullscreen: boolean;
    readonly show: boolean;
    readonly backgroundColor: string;
    readonly autoHideMenuBar: boolean;
    readonly webPreferences: typeof WEB_PREFERENCES;
  }) => ShellWindow;
  readonly config: ShellConfig;
  readonly fetch: typeof fetch;
  /** The installation's CA certificate (PEM) from `config.caFile`, if it is there yet. */
  readonly readCa: () => string | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  /** The start-up page's words (NFR-L02: from `@rp/i18n`). */
  readonly text: { readonly title: string; readonly starting: string };
  readonly log?: (message: string) => void;
}

/** How long to wait before reopening a window that closed or crashed. */
const REOPEN_MS = 1_000;

/** Chromium's `net::ERR_ABORTED`: a load replaced by another, such as the shell's own. */
const ERR_ABORTED = -3;

export interface Shell {
  /** The open window, if any. */
  window(): ShellWindow | undefined;
  /** Stops reopening windows, for quitting. */
  stop(): void;
}

export async function startShell(deps: ShellDeps): Promise<Shell | undefined> {
  const { app, config } = deps;
  const log = deps.log ?? (() => undefined);
  // One shell per PC: a second start brings the first to the front.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return undefined;
  }
  let current: ShellWindow | undefined;
  let quitting = false;
  const stop = () => {
    quitting = true;
  };
  app.on('before-quit', stop);
  // Never quit when the window closes: it comes back (NFR-A04).
  app.on('window-all-closed', () => undefined);
  app.on('second-instance', () => {
    if (current === undefined || current.isDestroyed()) return;
    if (current.isMinimized()) current.restore();
    current.focus();
  });

  await app.whenReady();
  app.setLoginItemSettings({ openAtLogin: config.openAtLogin });

  const session = deps.session();
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(
      isAllowedPermission(permission, details.requestingUrl, config.consoleUrl, details.mediaTypes),
    );
  });
  session.setPermissionCheckHandler((_contents, permission, origin, details) =>
    isAllowedPermission(
      permission,
      origin,
      config.consoleUrl,
      details.mediaType === undefined ? [] : [details.mediaType],
    ),
  );
  session.setCertificateVerifyProc((request, callback) => {
    const check = {
      hostname: request.hostname,
      errorCode: request.errorCode,
      certificatePem: request.certificate.data,
    };
    callback(certificateVerdict(check, deps.readCa()));
  });

  const open = async (): Promise<void> => {
    const window = deps.createWindow({
      fullscreen: config.fullScreen,
      show: true,
      backgroundColor: '#f4f4f2',
      autoHideMenuBar: true,
      webPreferences: WEB_PREFERENCES,
    });
    current = window;
    const contents = window.webContents;
    // Nowhere but the console: no other sites, no new windows.
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url, config.consoleUrl)) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', (_event, details) => {
      log(`The console page stopped (${details.reason}); reloading it`);
      if (!window.isDestroyed()) contents.reload();
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED || quitting || window.isDestroyed()) return;
      log(`The console did not load (${String(code)} ${description}); waiting for the server`);
      void showConsole(window);
    });
    // Windows is signing out or shutting down: let the shell go.
    window.on('session-end', stop);
    window.on('closed', () => {
      if (current === window) current = undefined;
      if (quitting) return;
      log('The window was closed; opening it again');
      void deps.sleep(REOPEN_MS).then(() => (quitting ? undefined : open()));
    });
    await showConsole(window);
  };

  /** Windows waiting for the server, so a second failure does not start a second wait. */
  const waiting = new Set<ShellWindow>();

  /** The start-up page until the server answers, then the console. */
  const showConsole = async (window: ShellWindow): Promise<void> => {
    if (waiting.has(window)) return;
    waiting.add(window);
    try {
      await window.loadURL(splashUrl(deps.text.title, deps.text.starting)).catch(() => undefined);
      await waitForServer({
        fetch: deps.fetch,
        healthUrl: healthUrlOf(config.consoleUrl),
        intervalMs: 500,
        maxIntervalMs: 5_000,
        sleep: deps.sleep,
      });
    } finally {
      waiting.delete(window);
    }
    if (!window.isDestroyed() && !quitting) {
      await window.loadURL(config.consoleUrl).catch(() => undefined);
    }
  };

  await open();
  return { window: () => current, stop };
}
