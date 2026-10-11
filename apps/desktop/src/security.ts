import { X509Certificate } from 'node:crypto';

/**
 * The shell's hardening (SEC-011): the console runs as a web page with no Node.js, no preload and
 * no IPC, only from the restaurant's own server on this PC, and with no permission it does not
 * need. Pure, so it is tested without Electron.
 */

/** BrowserWindow web preferences: context isolation, sandbox, no Node.js, no preload. */
export const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  // No developer tools in the POS window (DESKTOP-I3): they would read its session.
  devTools: false,
} as const;

/**
 * Chromium and Node.js switches that open the running console to another program (DESKTOP-E2).
 * No fuse covers Chromium's remote debugging, so the shell quits when it is started with one.
 */
const DEBUGGING_SWITCH = /^--?(remote-debugging-|remote-allow-origins|inspect|debug|js-flags)/i;

/** The first debugging switch in the command line, if there is one. */
export function debuggingSwitchIn(argv: readonly string[]): string | undefined {
  return argv.find((argument) => DEBUGGING_SWITCH.test(argument));
}

/** The loopback names the shell's server may answer on. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** Only the restaurant's server: same origin as the console's address. */
export function isAllowedNavigation(target: string, consoleUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(consoleUrl).origin;
  } catch {
    return false;
  }
}

/** Whether `certificatePem` was issued by, and carries the signature of, the CA in `caPem`. */
export function isIssuedBy(certificatePem: string, caPem: string): boolean {
  try {
    const certificate = new X509Certificate(certificatePem);
    const ca = new X509Certificate(caPem);
    return certificate.checkIssued(ca) && certificate.verify(ca.publicKey);
  } catch {
    return false;
  }
}

export interface CertificateCheck {
  readonly hostname: string;
  /** Chromium's own result: `0` when Windows trusts the certificate. */
  readonly errorCode: number;
  /** The certificate the server presented (PEM). */
  readonly certificatePem: string;
}

/**
 * Chromium's certificate verdict for the shell's session: `0` trusts, `-2` refuses, `-3` lets
 * Chromium decide. The server on this PC uses the installation's own CA (ADR-0011), which Windows
 * does not know. On a loopback address the shell trusts a certificate signed by that CA (`caPem`,
 * the server's `ca.crt`) and refuses any other; a process on this PC that is not the server
 * cannot pass as it, even with a certificate Windows trusts. Any other address, or no CA to pin,
 * is left to Chromium's normal checks.
 */
export function certificateVerdict(
  check: CertificateCheck,
  caPem: string | undefined,
): 0 | -2 | -3 {
  // On this PC's own address the pin decides, whatever Windows trusts (DESKTOP-S1): a root that
  // an antivirus program installed does not make another process the server.
  if (isLoopbackHost(check.hostname) && caPem !== undefined) {
    return isIssuedBy(check.certificatePem, caPem) ? 0 : -2;
  }
  return check.errorCode === 0 ? 0 : -3;
}

/**
 * Permissions the console may have: notifications (alerts on the POS) and the camera for scanning
 * a pager's QR code (P2-04b2), from its own server only. Everything else is refused, the
 * microphone included: `media` is the camera only (`mediaTypes`, Electron's `video` or `audio`).
 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'media', 'clipboard-sanitized-write']);

export function isAllowedPermission(
  permission: string,
  requestingUrl: string,
  consoleUrl: string,
  mediaTypes: readonly string[] = [],
): boolean {
  if (permission === 'media' && mediaTypes.includes('audio')) return false;
  return ALLOWED_PERMISSIONS.has(permission) && isAllowedNavigation(requestingUrl, consoleUrl);
}

/** The Content-Security-Policy of the shell's own start-up page: nothing loads, nothing runs. */
export const SPLASH_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
