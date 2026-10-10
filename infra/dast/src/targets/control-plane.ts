import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { VendorSessionView, VendorSetupResponse } from '@rp/contracts/control-plane';
import { cloneTemplateDatabase, startTestDatabase } from '@rp/test-postgres';
import { base32Decode, hotp, totpStep } from '@rp/totp';
import { escaped, urlsUnder } from '../credentials.js';
import {
  freePort,
  REPO,
  type RunningTarget,
  startService,
  stopService,
  waitUntil,
} from './common.js';

const CONTROL_PLANE = join(REPO, 'apps', 'control-plane');
const WEB = join(REPO, 'apps', 'control-plane-web', 'dist');
const EMAIL = 'scanner@vendor.example';
const PASSWORD = 'a long passphrase only the scan knows';

/**
 * The built Control Plane with the vendor web app, on a throwaway database, as `CP_ENV`
 * development (staging insists on TLS to its database, which the throwaway one does not offer;
 * HSTS, the one header that differs, is checked in admin.int.test.ts). The scan signs in as a
 * Super Admin set up exactly as the runbook says: the CLI's setup token, a password, the
 * authenticator. Restaurant PCs' endpoints need a signature per request, which ZAP cannot make:
 * it attacks them unsigned.
 */
export async function startControlPlane(logFile: string): Promise<RunningTarget> {
  for (const built of [join(CONTROL_PLANE, 'dist', 'main.js'), join(WEB, 'index.html')]) {
    if (!existsSync(built)) throw new Error(`${built} is missing: run pnpm build first`);
  }
  const cluster = await startTestDatabase({
    migrationsDir: join(CONTROL_PLANE, 'prisma', 'migrations'),
    prefix: 'dastcp',
  });
  const database = await cloneTemplateDatabase({
    adminUrl: cluster.adminUrl,
    templateDatabase: cluster.templateDatabase,
    runId: cluster.runId,
    prefix: 'dastcp',
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const env = {
    CP_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: database.url,
    CP_SECRET_KEY: randomBytes(32).toString('base64'),
    CP_WEB_DIR: WEB,
    CP_BILLING_INTERVAL_MINUTES: '0',
    CP_ACTOR: 'cli:dast',
    LOG_LEVEL: 'warn',
  };
  const child = startService(process.execPath, [join(CONTROL_PLANE, 'dist', 'main.js')], {
    env,
    logFile,
  });
  try {
    await waitUntil('The Control Plane', async () => (await fetch(`${base}/v1/health`)).ok, child);
    const printed = execFileSync(
      process.execPath,
      [
        join(CONTROL_PLANE, 'dist', 'cli.js'),
        'vendor-user:create',
        '--email',
        EMAIL,
        '--name',
        'DAST Scanner',
        '--role',
        'SUPER_ADMIN',
      ],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    const setupToken = /Setup token[^:]*: ([A-Za-z0-9_-]{43})/.exec(printed)?.[1];
    if (setupToken === undefined) throw new Error('The CLI printed no setup token');
    const post = async (path: string, body: unknown): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
      }
      return response.json();
    };
    const { secret } = VendorSetupResponse.parse(
      await post('/v1/vendor/setup', { token: setupToken, password: PASSWORD }),
    );
    const key = base32Decode(secret);
    // Each code signs in once: the next sign-in waits for the authenticator's next step.
    let step = 0;
    const nextCode = async (): Promise<string> => {
      while (totpStep(new Date()) <= step) await sleep(1_000);
      step = totpStep(new Date());
      return hotp(key, step);
    };
    await post('/v1/vendor/setup/confirm', { token: setupToken, code: await nextCode() });
    const signIn = async (): Promise<string> =>
      VendorSessionView.parse(
        await post('/v1/vendor/session', {
          email: EMAIL,
          password: PASSWORD,
          code: await nextCode(),
        }),
      ).token;
    let token = await signIn();
    return {
      target: {
        name: 'control-plane',
        baseUrl: base,
        pages: [
          `${base}/`,
          `${base}/fleet`,
          // A digital bill's page; this link is in no bill, so it is the page that says so.
          `${base}/v1/bills/${randomBytes(32).toString('base64url')}`,
        ],
        openApi: { file: 'control-plane.openapi.json', targetUrl: base },
        exclude: [
          {
            url: `${escaped(base)}/v1/vendor/session`,
            why: "signing in and out would end the scan's own session; vendor-staff.int.test.ts attacks sign-in",
          },
        ],
        activeScanMinutes: 15,
      },
      openApiSource: join(REPO, 'docs', 'api', 'control-plane.openapi.json'),
      headerRules: () => [
        { url: urlsUnder(base, '/v1/vendor/'), headers: { authorization: `Bearer ${token}` } },
      ],
      async keepFresh() {
        const me = await fetch(`${base}/v1/vendor/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (me.ok) return false;
        token = await signIn();
        return true;
      },
      async stop() {
        await stopService(child);
        await database.drop().catch(() => undefined);
        await cluster.stop();
      },
    };
  } catch (error) {
    await stopService(child);
    await cluster.stop();
    throw error;
  }
}
