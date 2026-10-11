import { execFile } from 'node:child_process';
import { join, parse, resolve } from 'node:path';
import type { DiskEncryption } from '@rp/contracts';
import { encodedCommand } from '../auth/dpapi.js';

/**
 * Whether the data drive is encrypted (PC-I5, SEC-007): the database, logs and WAL archive are
 * plain files, so a stolen PC or disk gives up everything unless BitLocker is on. Windows only;
 * anywhere else the answer is UNKNOWN, which the System page does not warn about.
 */

/** BitLocker's protection status for the drive in `RP_DRIVE` (`On` or `Off`). */
export const DISK_ENCRYPTION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::Out.Write([string](Get-BitLockerVolume -MountPoint $env:RP_DRIVE).ProtectionStatus)',
].join('\n');

/**
 * Reads `ProtectionStatus`. A drive encrypted with protection suspended reads Off, which is right:
 * its key is in the clear.
 */
export function parseProtectionStatus(output: string): DiskEncryption {
  switch (output.trim().toLowerCase()) {
    case 'on':
    case '1':
      return 'ENCRYPTED';
    case 'off':
    case '0':
      return 'NOT_ENCRYPTED';
    default:
      return 'UNKNOWN';
  }
}

/** The drive's root (`C:\`) the data folder is on. */
export function driveOf(dataDir: string): string {
  return parse(resolve(dataDir)).root;
}

export type DiskEncryptionProbe = (drive: string) => Promise<string>;

function powerShellProbe(timeoutMs: number): DiskEncryptionProbe {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return (drive) =>
    new Promise((resolveOutput, reject) => {
      execFile(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodedCommand(DISK_ENCRYPTION_SCRIPT),
        ],
        {
          windowsHide: true,
          timeout: timeoutMs,
          env: { ...process.env, RP_DRIVE: drive.replace(/[\\/]+$/, '') },
        },
        (error, stdout) => {
          if (error) reject(new Error(error.message));
          else resolveOutput(stdout);
        },
      );
    });
}

const CACHE_MS = 10 * 60_000;
let cached: { drive: string; at: number; value: DiskEncryption } | null = null;

/**
 * The data drive's encryption, read at most every ten minutes (the System page is read often and
 * PowerShell is slow); UNKNOWN off Windows or when Windows cannot say.
 */
export async function diskEncryption(
  dataDir: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly probe?: DiskEncryptionProbe;
    readonly now?: number;
  } = {},
): Promise<DiskEncryption> {
  if ((options.platform ?? process.platform) !== 'win32') return 'UNKNOWN';
  const drive = driveOf(dataDir);
  const now = options.now ?? Date.now();
  if (cached !== null && cached.drive === drive && now - cached.at < CACHE_MS) {
    return cached.value;
  }
  let value: DiskEncryption;
  try {
    value = parseProtectionStatus(await (options.probe ?? powerShellProbe(20_000))(drive));
  } catch {
    value = 'UNKNOWN';
  }
  cached = { drive, at: now, value };
  return value;
}

/** For tests. */
export function forgetDiskEncryption(): void {
  cached = null;
}
