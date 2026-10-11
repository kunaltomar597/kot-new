import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Windows DPAPI (SEC-006): protects bytes with a key Windows keeps for this PC, so a secret file
 * copied off the data drive cannot be read anywhere else. Both calls take and return several values
 * at once, so a start-up that needs every secret pays for one call.
 */
export interface Dpapi {
  protect(values: readonly Buffer[]): Promise<Buffer[]>;
  unprotect(values: readonly Buffer[]): Promise<Buffer[]>;
}

/**
 * Mixed into every protected value, so another program using the PC's DPAPI key cannot unprotect
 * the secrets without knowing it. Changing it makes every stored secret unreadable.
 */
export const DPAPI_ENTROPY = 'RestaurantPlatform/secret-store/v1';

/**
 * The PowerShell that does the work: one base64 value per line in, one per line out. The values
 * travel over the pipes, never on a command line another process could read.
 */
export function dpapiScript(direction: 'protect' | 'unprotect'): string {
  const call = direction === 'protect' ? 'Protect' : 'Unprotect';
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Security',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    // Machine scope: the server's service account, the restore tool the service runs and the
    // installer (an administrator) all read the same secrets. The folder's permissions keep
    // everyone else out (P0-16c).
    '$scope = [Security.Cryptography.DataProtectionScope]::LocalMachine',
    '$in = [Console]::In',
    'while ($null -ne ($line = $in.ReadLine())) {',
    "  if ($line.Trim() -eq '') { continue }",
    `  $out = [Security.Cryptography.ProtectedData]::${call}([Convert]::FromBase64String($line.Trim()), $entropy, $scope)`,
    '  [Console]::Out.WriteLine([Convert]::ToBase64String($out))',
    '}',
  ].join('\n');
}

/** `-EncodedCommand` takes the script as base64 of UTF-16LE. */
export function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export interface PowerShellDpapiOptions {
  /** Windows PowerShell 5.1, by its full path so nothing on the PATH can stand in for it. */
  readonly powershell?: string;
  readonly timeoutMs?: number;
}

/** DPAPI through Windows PowerShell's `ProtectedData`; no native module to build or ship. */
export function powerShellDpapi(options: PowerShellDpapiOptions = {}): Dpapi {
  const powershell =
    options.powershell ??
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  const timeoutMs = options.timeoutMs ?? 60_000;
  const run = (direction: 'protect' | 'unprotect', values: readonly Buffer[]) =>
    new Promise<Buffer[]>((resolve, reject) => {
      if (values.length === 0) {
        resolve([]);
        return;
      }
      const child = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodedCommand(dpapiScript(direction)),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code !== 0) {
          // PowerShell's error text says what failed; it never holds the values.
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500);
          reject(
            new Error(
              `DPAPI ${direction} failed (${signal ?? `exit ${String(code)}`}): ${detail || 'no detail'}`,
            ),
          );
          return;
        }
        const lines = Buffer.concat(stdout)
          .toString('ascii')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== '');
        if (lines.length !== values.length) {
          reject(
            new Error(
              `DPAPI ${direction} returned ${String(lines.length)} values for ${String(values.length)}`,
            ),
          );
          return;
        }
        resolve(lines.map((line) => Buffer.from(line, 'base64')));
      });
      child.stdin.end(values.map((value) => `${value.toString('base64')}\n`).join(''));
    });
  return {
    protect: (values) => run('protect', values),
    unprotect: (values) => run('unprotect', values),
  };
}
