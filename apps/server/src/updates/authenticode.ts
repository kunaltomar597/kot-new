import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { encodedCommand } from '../auth/dpapi.js';

/**
 * Authenticode for update installers (UPD-007, P7-04c). Windows checks the signature and its
 * chain; the installer is accepted only when it is valid and signed by the vendor's certificate
 * (the publisher the installer's build named). The updater checks again before it runs the
 * installer as SYSTEM; this early check lets the System page say why an update waits.
 */

/** What Windows says about a file's signature (`Get-AuthenticodeSignature`). */
export interface SignatureSeen {
  /** `Valid`, `NotSigned`, `HashMismatch`, `NotTrusted`, `UnknownError`, ... */
  readonly status: string;
  /** The signer certificate's subject, or null when unsigned. */
  readonly subject: string | null;
}

export type SignatureCheck = (file: string) => Promise<SignatureSeen>;

export interface SignaturePolicy {
  readonly publisher: string | null;
  readonly allowUnsigned: boolean;
}

/** Why updates cannot be checked on this installation, or null when they can. */
export function signaturePolicyProblem(policy: SignaturePolicy): string | null {
  if (policy.publisher === null && !policy.allowUnsigned) {
    return 'This installation cannot check an update’s signature: it was built without a code-signing certificate. Install updates by hand, or ask support.';
  }
  return null;
}

export type SignatureVerdict =
  | { readonly ok: true; readonly signer: string | null }
  | { readonly ok: false; readonly reason: string };

export function judgeSignature(seen: SignatureSeen, policy: SignaturePolicy): SignatureVerdict {
  if (seen.status === 'Valid') {
    if (policy.publisher === null) {
      return policy.allowUnsigned
        ? { ok: true, signer: seen.subject }
        : { ok: false, reason: 'No publisher to check the signature against.' };
    }
    return seen.subject === policy.publisher
      ? { ok: true, signer: seen.subject }
      : {
          ok: false,
          reason: `The installer is signed by ${seen.subject ?? 'someone else'}, not by the vendor.`,
        };
  }
  if (seen.status === 'NotSigned' && policy.allowUnsigned) return { ok: true, signer: null };
  return {
    ok: false,
    reason:
      seen.status === 'NotSigned'
        ? 'The installer is not signed.'
        : `The installer’s signature is not valid (${seen.status}).`,
  };
}

/** The PowerShell that reads the signature; the file's path comes in an environment variable. */
export const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:RP_SIGNED_FILE',
  '$subject = $null',
  'if ($null -ne $signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject }',
  '[Console]::Out.Write((@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress))',
].join('\n');

/** The check through Windows PowerShell 5.1, which every Windows PC has. */
export function powerShellSignatureCheck(
  options: { readonly powershell?: string; readonly timeoutMs?: number } = {},
): SignatureCheck {
  const powershell =
    options.powershell ??
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  return (file) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodedCommand(SIGNATURE_SCRIPT),
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: options.timeoutMs ?? 60_000,
          env: { ...process.env, RP_SIGNED_FILE: file },
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 300);
          reject(new Error(`The signature check failed: ${detail || `exit ${String(code)}`}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
            status?: unknown;
            subject?: unknown;
          };
          resolve({
            status: typeof parsed.status === 'string' ? parsed.status : 'UnknownError',
            subject: typeof parsed.subject === 'string' ? parsed.subject : null,
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
}
