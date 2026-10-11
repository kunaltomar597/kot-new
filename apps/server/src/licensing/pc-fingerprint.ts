import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FingerprintKind } from '@rp/licensing';

const run = promisify(execFile);

/** Injection token for the `FingerprintReader`. */
export const FINGERPRINT_READER = Symbol('FINGERPRINT_READER');

export type Identifiers = Partial<Record<FingerprintKind, string | null>>;

/** Reads the PC's hardware identifiers (LIC-004); tests replace it. */
export interface FingerprintReader {
  read(): Promise<Identifiers>;
}

/** One PowerShell call reading the five identifiers on Windows, as JSON. */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$c = Get-CimInstance Win32_ComputerSystemProduct',
  '$b = Get-CimInstance Win32_BaseBoard',
  '$d = Get-CimInstance Win32_DiskDrive | Sort-Object Index | Select-Object -First 1',
  '$p = Get-CimInstance Win32_Processor | Select-Object -First 1',
  "$m = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
  '@{ MACHINE_ID = $m; BOARD_SERIAL = $b.SerialNumber; BIOS_UUID = $c.UUID;',
  '   DISK_SERIAL = $d.SerialNumber; CPU_ID = $p.ProcessorId } | ConvertTo-Json -Compress',
].join('\n');

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The identifiers from the Windows script's JSON. */
export function parseWindows(output: string): Identifiers {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    return {
      MACHINE_ID: text(value.MACHINE_ID),
      BOARD_SERIAL: text(value.BOARD_SERIAL),
      BIOS_UUID: text(value.BIOS_UUID),
      DISK_SERIAL: text(value.DISK_SERIAL),
      CPU_ID: text(value.CPU_ID),
    };
  } catch {
    return {};
  }
}

/** The identifiers macOS gives without privileges (development machines). */
export function parseMac(ioreg: string, disk: string, cpu: string): Identifiers {
  const field = (name: string) => new RegExp(`"${name}" = "([^"]+)"`).exec(ioreg)?.[1] ?? null;
  return {
    MACHINE_ID: field('IOPlatformUUID'),
    BOARD_SERIAL: field('IOPlatformSerialNumber'),
    BIOS_UUID: field('board-id') ?? field('model'),
    DISK_SERIAL: /Volume UUID:\s+(\S+)/.exec(disk)?.[1] ?? null,
    CPU_ID: text(cpu),
  };
}

async function output(command: string, args: readonly string[]): Promise<string> {
  try {
    return (await run(command, [...args], { timeout: 15_000, windowsHide: true })).stdout;
  } catch {
    return '';
  }
}

async function fileText(path: string): Promise<string | null> {
  try {
    return text(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The real reader: PowerShell and WMI on the restaurant's Windows PC; `ioreg` on a Mac and
 * `/etc/machine-id` and DMI on Linux for development. Whatever cannot be read is null, and never
 * matches (`@rp/licensing` `fingerprintMatchCount`).
 */
export class SystemFingerprintReader implements FingerprintReader {
  async read(): Promise<Identifiers> {
    switch (process.platform) {
      case 'win32':
        return parseWindows(
          await output('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            WINDOWS_SCRIPT,
          ]),
        );
      case 'darwin':
        return parseMac(
          await output('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']),
          await output('diskutil', ['info', '/']),
          await output('sysctl', ['-n', 'machdep.cpu.brand_string']),
        );
      default:
        return {
          MACHINE_ID: await fileText('/etc/machine-id'),
          BOARD_SERIAL: await fileText('/sys/class/dmi/id/board_serial'),
          BIOS_UUID: await fileText('/sys/class/dmi/id/product_uuid'),
          DISK_SERIAL: null,
          CPU_ID: null,
        };
    }
  }
}
