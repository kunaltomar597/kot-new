import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceControl } from '../../src/service/watchdog.js';
import { UPDATER_PICKUP_MS, UPDATER_RETRY_MS, Watchdog } from '../../src/service/watchdog.js';
import { type RunCommand, WindowsServiceControl } from '../../src/service/windows-services.js';
import { UPDATER_TASK } from '../../src/installation/installation.js';
import {
  installerVersionProblem,
  judgeSignature,
  powerShellSignatureCheck,
  SIGNATURE_SCRIPT,
  signaturePolicyProblem,
} from '../../src/updates/authenticode.js';
import {
  downloadInstaller,
  installerMatches,
  UpdateDownloadError,
} from '../../src/updates/update-download.js';
import {
  installerFileName,
  readUpdateOutcome,
  readUpdateRequest,
  removeUpdateRequest,
  updateOutcomePath,
  type UpdateRequestFile,
  updateRequestPath,
  writeUpdateRequest,
} from '../../src/updates/update-files.js';

const INSTALLER = Buffer.from('MZ pretend installer '.repeat(1_000));
const SHA = createHash('sha256').update(INSTALLER).digest('hex');
const URL_ = 'https://downloads.example.com/RestaurantPlatform-Setup-1.2.0.exe';

/** The address a fetch was given, whatever form it came in. */
const addressOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A fetch that answers with `body`, in chunks, from the address it ended at. */
function fakeFetch(
  body: Buffer,
  options: { status?: number; url?: string; chunk?: number; asked?: string[] } = {},
): typeof fetch {
  return (input) => {
    options.asked?.push(addressOf(input));
    const chunk = options.chunk ?? 4_096;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < body.length; offset += chunk) {
          controller.enqueue(new Uint8Array(body.subarray(offset, offset + chunk)));
        }
        controller.close();
      },
    });
    const response = new Response(stream, { status: options.status ?? 200 });
    Object.defineProperty(response, 'url', { value: options.url ?? URL_ });
    return Promise.resolve(response);
  };
}

const folder = () => mkdtempSync(join(tmpdir(), 'rp-updates-'));

describe('[UPD-004] [UPD-007] downloading an update', () => {
  it('downloads over HTTPS and keeps the file only when its size and SHA-256 match', async () => {
    const target = join(folder(), 'RestaurantPlatform-Setup-1.2.0.exe');
    await downloadInstaller({
      url: URL_,
      sha256: SHA,
      sizeBytes: INSTALLER.length,
      target,
      fetch: fakeFetch(INSTALLER),
    });
    expect(readFileSync(target).equals(INSTALLER)).toBe(true);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(await installerMatches(target, { sha256: SHA, sizeBytes: INSTALLER.length })).toBe(true);
    writeFileSync(target, Buffer.concat([INSTALLER.subarray(1), Buffer.from('x')]));
    expect(await installerMatches(target, { sha256: SHA, sizeBytes: INSTALLER.length })).toBe(
      false,
    );
    expect(
      await installerMatches(join(folder(), 'missing.exe'), { sha256: SHA, sizeBytes: 1 }),
    ).toBe(false);
  });

  it('refuses plain HTTP, a redirect away from HTTPS and a refused request', async () => {
    const target = join(folder(), 'a.exe');
    const base = { sha256: SHA, sizeBytes: INSTALLER.length, target };
    const problem = (promise: Promise<void>) =>
      promise.then(
        () => 'none',
        (error: unknown) => (error instanceof UpdateDownloadError ? error.problem : 'other'),
      );
    expect(
      await problem(
        downloadInstaller({
          ...base,
          url: 'http://example.com/a.exe',
          fetch: fakeFetch(INSTALLER),
        }),
      ),
    ).toBe('NOT_HTTPS');
    expect(
      await problem(
        downloadInstaller({
          ...base,
          url: URL_,
          fetch: fakeFetch(INSTALLER, { url: 'http://mirror.example.com/a.exe' }),
        }),
      ),
    ).toBe('NOT_HTTPS');
    expect(
      await problem(
        downloadInstaller({
          ...base,
          url: URL_,
          fetch: fakeFetch(Buffer.alloc(0), { status: 404 }),
        }),
      ),
    ).toBe('HTTP_STATUS');
    expect(
      await problem(
        downloadInstaller({
          ...base,
          url: URL_,
          fetch: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
        }),
      ),
    ).toBe('NETWORK');
    expect(existsSync(target)).toBe(false);
  });

  it('follows redirects by itself, to HTTPS only, never asking anything over HTTP', async () => {
    const target = join(folder(), 'a.exe');
    const asked: string[] = [];
    const redirects = (to: string): typeof fetch => {
      const file = fakeFetch(INSTALLER, { asked });
      return (input, init) => {
        expect(init?.redirect).toBe('manual');
        if (addressOf(input) === URL_) {
          asked.push(addressOf(input));
          return Promise.resolve(new Response(null, { status: 302, headers: { location: to } }));
        }
        return file(input, init);
      };
    };
    await downloadInstaller({
      url: URL_,
      sha256: SHA,
      sizeBytes: INSTALLER.length,
      target,
      fetch: redirects('https://cdn.example.com/a.exe'),
    });
    expect(asked).toEqual([URL_, 'https://cdn.example.com/a.exe']);
    expect(readFileSync(target).equals(INSTALLER)).toBe(true);

    asked.length = 0;
    const refused = await downloadInstaller({
      url: URL_,
      sha256: SHA,
      sizeBytes: INSTALLER.length,
      target: join(folder(), 'b.exe'),
      fetch: redirects('http://mirror.example.com/a.exe'),
    }).then(
      () => 'none',
      (error: unknown) => (error instanceof UpdateDownloadError ? error.problem : 'other'),
    );
    expect(refused).toBe('NOT_HTTPS');
    // The plain HTTP address was never asked.
    expect(asked).toEqual([URL_]);
  });

  it('refuses a download that is too long, too short or not the release', async () => {
    const target = join(folder(), 'a.exe');
    const attempt = (body: Buffer) =>
      downloadInstaller({
        url: URL_,
        sha256: SHA,
        sizeBytes: INSTALLER.length,
        target,
        fetch: fakeFetch(body),
      }).then(
        () => 'none',
        (error: unknown) => (error instanceof UpdateDownloadError ? error.problem : 'other'),
      );
    expect(await attempt(Buffer.concat([INSTALLER, Buffer.alloc(10)]))).toBe('SIZE');
    expect(await attempt(INSTALLER.subarray(0, 100))).toBe('SIZE');
    const tampered = Buffer.from(INSTALLER);
    tampered[50] = 0x41;
    expect(await attempt(tampered)).toBe('HASH');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
  });
});

describe('[UPD-007] the installer’s signature', () => {
  const vendor = 'CN=Restaurant Platform Pvt Ltd, O=Restaurant Platform Pvt Ltd, C=IN';

  it('accepts only a valid signature by the vendor', () => {
    const policy = { publisher: vendor, allowUnsigned: false };
    expect(judgeSignature({ status: 'Valid', subject: vendor }, policy)).toEqual({
      ok: true,
      signer: vendor,
    });
    expect(judgeSignature({ status: 'Valid', subject: 'CN=Someone Else' }, policy)).toEqual({
      ok: false,
      reason: 'The installer is signed by CN=Someone Else, not by the vendor.',
    });
    expect(judgeSignature({ status: 'NotSigned', subject: null }, policy)).toEqual({
      ok: false,
      reason: 'The installer is not signed.',
    });
    expect(judgeSignature({ status: 'HashMismatch', subject: vendor }, policy)).toEqual({
      ok: false,
      reason: 'The installer’s signature is not valid (HashMismatch).',
    });
  });

  it('[UPDATE-S2] refuses the vendor’s name from another authority', () => {
    const ca = 'CN=Real Code Signing CA, O=Real CA, C=US';
    const policy = { publisher: vendor, issuer: ca, allowUnsigned: false };
    expect(judgeSignature({ status: 'Valid', subject: vendor, issuer: ca }, policy)).toEqual({
      ok: true,
      signer: vendor,
    });
    const fake = judgeSignature(
      { status: 'Valid', subject: vendor, issuer: 'CN=Cheap CA, C=XX' },
      policy,
    );
    expect(fake).toEqual({
      ok: false,
      reason: 'The installer’s certificate was issued by CN=Cheap CA, C=XX, not by the vendor’s.',
    });
    // An issuer that was not read is not the vendor's authority either.
    expect(judgeSignature({ status: 'Valid', subject: vendor }, policy).ok).toBe(false);
    // The subject is still checked first, and a policy without an issuer checks the subject only.
    expect(judgeSignature({ status: 'Valid', subject: 'CN=Other', issuer: ca }, policy).ok).toBe(
      false,
    );
    expect(
      judgeSignature({ status: 'Valid', subject: vendor }, { ...policy, issuer: null }).ok,
    ).toBe(true);
    expect(SIGNATURE_SCRIPT).toContain('SignerCertificate.Issuer');
  });

  it('takes unsigned installers only on a test build, and never a damaged signature', () => {
    const test = { publisher: null, allowUnsigned: true };
    expect(judgeSignature({ status: 'NotSigned', subject: null }, test).ok).toBe(true);
    expect(judgeSignature({ status: 'HashMismatch', subject: null }, test).ok).toBe(false);
    expect(signaturePolicyProblem(test)).toBeNull();
    expect(signaturePolicyProblem({ publisher: vendor, allowUnsigned: false })).toBeNull();
    expect(signaturePolicyProblem({ publisher: null, allowUnsigned: false })).toMatch(
      /without a code-signing certificate/,
    );
    expect(
      judgeSignature(
        { status: 'Valid', subject: vendor },
        { publisher: null, allowUnsigned: false },
      ).ok,
    ).toBe(false);
  });

  it('asks Windows with the path in the environment, not in the script', () => {
    expect(SIGNATURE_SCRIPT).toContain(
      'Get-AuthenticodeSignature -LiteralPath $env:RP_SIGNED_FILE',
    );
    expect(SIGNATURE_SCRIPT).not.toMatch(/\.exe/);
  });

  it('[UPD-002] refuses an installer that is not the version the release names', () => {
    const seen = { status: 'Valid', subject: vendor };
    expect(installerVersionProblem({ ...seen, productVersion: '1.2.0' }, '1.2.0')).toBeNull();
    expect(installerVersionProblem({ ...seen, productVersion: '1.0.5' }, '1.2.0')).toBe(
      'The installer installs version 1.0.5, not version 1.2.0 as the release says.',
    );
    expect(installerVersionProblem({ ...seen, productVersion: '1.2.0-rc.1' }, '1.2.0')).toMatch(
      /version 1\.2\.0-rc\.1, not/,
    );
    expect(installerVersionProblem({ ...seen, productVersion: null }, '1.2.0')).toMatch(
      /installs no version/,
    );
    // Not read (off Windows): the updater checks it before it runs the installer.
    expect(installerVersionProblem(seen, '1.2.0')).toBeNull();
    expect(SIGNATURE_SCRIPT).toContain(
      '(Get-Item -LiteralPath $env:RP_SIGNED_FILE).VersionInfo.ProductVersion',
    );
  });

  it.runIf(process.platform === 'win32')('reads a real file’s signature on Windows', async () => {
    const file = join(folder(), 'unsigned.exe');
    writeFileSync(file, INSTALLER);
    const seen = await powerShellSignatureCheck()(file);
    expect(['NotSigned', 'UnknownError']).toContain(seen.status);
    expect(seen.subject).toBeNull();
    expect(seen.productVersion).toBeNull();
  });
});

describe('[UPD-005] the hand-off to the updater', () => {
  const request: UpdateRequestFile = {
    format: 1,
    requestId: '0199b0e0-0000-7000-8000-000000000001',
    version: '1.2.0',
    previousVersion: '1.1.0',
    fileName: installerFileName('1.2.0'),
    sha256: SHA,
    sizeBytes: INSTALLER.length,
    securityCritical: false,
    trigger: 'WINDOW',
    approvedByStaffId: null,
    backupFileName: 'rp-backup-20261005T213000Z-update.rpbk',
    requestedAt: '2026-10-05T21:30:00.000Z',
  };

  it('names installers by version and writes the request whole', async () => {
    expect(installerFileName('1.2.0')).toBe('RestaurantPlatform-Setup-1.2.0.exe');
    const data = folder();
    expect(await readUpdateRequest(data)).toBeNull();
    await writeUpdateRequest(data, request);
    expect(existsSync(`${updateRequestPath(data)}.new`)).toBe(false);
    expect(await readUpdateRequest(data)).toEqual(request);
    await removeUpdateRequest(data);
    expect(await readUpdateRequest(data)).toBeNull();
    await expect(
      writeUpdateRequest(data, { ...request, fileName: '..\\evil.exe' }),
    ).rejects.toThrow();
  });

  it('reads the updater’s outcome as Windows PowerShell writes it, and ignores a bad one', async () => {
    const data = folder();
    await writeUpdateRequest(data, request);
    const outcome = {
      format: 1,
      requestId: request.requestId,
      version: '1.2.0',
      previousVersion: '1.1.0',
      outcome: 'ROLLED_BACK',
      error: 'The new version did not pass its health check.',
      startedAt: '2026-10-05T21:31:00.000Z',
      finishedAt: '2026-10-05T21:40:12.345+05:30',
      logFile: 'C:\\ProgramData\\RestaurantPlatform\\setup-logs\\update-20261006-030100.log',
    };
    writeFileSync(updateOutcomePath(data), `\uFEFF${JSON.stringify(outcome)}`);
    expect(await readUpdateOutcome(data)).toEqual(outcome);
    writeFileSync(updateOutcomePath(data), '{"format":1');
    expect(await readUpdateOutcome(data)).toBeNull();
    writeFileSync(updateOutcomePath(data), JSON.stringify({ ...outcome, outcome: 'MAYBE' }));
    expect(await readUpdateOutcome(data)).toBeNull();
  });
});

describe('[UPD-005] the watchdog starts the updater', () => {
  function rig() {
    let pending: string | null = null;
    let maintenance = false;
    let clock = 0;
    let fail = false;
    let taken: string | null = null;
    const started: string[] = [];
    const log: string[] = [];
    const control: ServiceControl = {
      state: () => Promise.resolve('RUNNING'),
      start: () => Promise.resolve(),
      restart: () => Promise.resolve(),
    };
    const watchdog = new Watchdog({
      control,
      services: { database: 'RPDatabase', server: 'RPServer' },
      readHost: () => Promise.resolve(null),
      probe: () => Promise.resolve('ok'),
      maintenance: () => Promise.resolve(maintenance),
      pendingUpdate: () => Promise.resolve(pending),
      updateTaken: (requestId) => Promise.resolve(requestId === taken),
      runUpdater: () => {
        if (fail) return Promise.reject(new Error('The system cannot find the file specified.'));
        started.push(pending ?? '');
        return Promise.resolve();
      },
      log: (level, message) => log.push(`${level}: ${message}`),
      clock: () => clock,
    });
    return {
      watchdog,
      started,
      log,
      set: (values: {
        pending?: string | null;
        maintenance?: boolean;
        clock?: number;
        fail?: boolean;
        taken?: string | null;
      }) => {
        if (values.taken !== undefined) taken = values.taken;
        if (values.pending !== undefined) pending = values.pending;
        if (values.maintenance !== undefined) maintenance = values.maintenance;
        if (values.clock !== undefined) clock = values.clock;
        if (values.fail !== undefined) fail = values.fail;
      },
    };
  }

  it('once for each request the server leaves, never during maintenance', async () => {
    const { watchdog, started, set } = rig();
    await watchdog.check();
    expect(started).toEqual([]);
    set({ pending: 'request-1', maintenance: true });
    await watchdog.check();
    expect(started).toEqual([]);
    set({ maintenance: false });
    await watchdog.check();
    await watchdog.check();
    expect(started).toEqual(['request-1']);
    // Taken: never started again, even after the pick-up time (a request the server still holds).
    set({ taken: 'request-1', clock: UPDATER_PICKUP_MS * 3 });
    await watchdog.check();
    expect(started).toEqual(['request-1']);
    set({ pending: 'request-2' });
    await watchdog.check();
    expect(started).toEqual(['request-1', 'request-2']);
  });

  it('starts it again when the updater has not taken the request two minutes on', async () => {
    const { watchdog, started, set } = rig();
    set({ pending: 'request-1' });
    await watchdog.check();
    set({ clock: UPDATER_PICKUP_MS - 1 });
    await watchdog.check();
    expect(started).toEqual(['request-1']);
    set({ clock: UPDATER_PICKUP_MS });
    await watchdog.check();
    expect(started).toEqual(['request-1', 'request-1']);
    set({ taken: 'request-1', clock: UPDATER_PICKUP_MS * 3 });
    await watchdog.check();
    expect(started).toHaveLength(2);
  });

  it('tries again a minute after the task could not be started', async () => {
    const { watchdog, started, log, set } = rig();
    set({ pending: 'request-1', fail: true });
    await watchdog.check();
    expect(log).toContain('error: The updater could not be started');
    set({ fail: false, clock: UPDATER_RETRY_MS - 1 });
    await watchdog.check();
    expect(started).toEqual([]);
    set({ clock: UPDATER_RETRY_MS });
    await watchdog.check();
    expect(started).toEqual(['request-1']);
  });

  it('runs the updater’s scheduled task with schtasks.exe', async () => {
    const calls: string[] = [];
    let code = 0;
    const run: RunCommand = (program, args) => {
      calls.push(`${program.split(/[\\/]/).at(-1) ?? ''} ${args.join(' ')}`);
      return Promise.resolve({ code, output: code === 0 ? 'SUCCESS' : 'ERROR: not found' });
    };
    const control = new WindowsServiceControl({ run, systemRoot: 'C:\\Windows' });
    await control.runTask(UPDATER_TASK);
    expect(calls).toEqual(['schtasks.exe /Run /TN \\RestaurantPlatform\\Update']);
    code = 1;
    await expect(control.runTask(UPDATER_TASK)).rejects.toThrow(/ERROR: not found/);
  });
});
