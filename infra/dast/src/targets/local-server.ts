import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_TOKEN_HEADER,
  DeviceChallengeResponse,
  DeviceTokenResponse,
  deviceTokenMessage,
  LoginResponse,
} from '@rp/contracts';
import { cloneTemplateDatabase, startTestDatabase } from '@rp/test-postgres';
import pg from 'pg';
import { escaped, urlsUnder } from '../credentials.js';
import {
  freePort,
  REPO,
  type RunningTarget,
  startService,
  stopService,
  waitUntil,
} from './common.js';

const SERVER = join(REPO, 'apps', 'server');
const CONSOLE = join(REPO, 'apps', 'console', 'dist');
/** The development seed's Owner and PIN (apps/server/src/database/dev-seed.ts). */
const OWNER = { name: 'Asha (Owner)', pin: '1111' };
/** Renew the access token well before its 15 minutes run out. */
const RENEW_AFTER_MS = 10 * 60_000;

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A JSON call over HTTPS, trusting only the installation's CA, as the apps pin it. */
function call(
  ca: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method,
        ca,
        headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // Not JSON: kept as text.
          }
          resolve({ status: incoming.statusCode ?? 0, body: parsed });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * The built local server as the restaurant PC runs it (HTTPS with the installation's own CA, the
 * built console on the same origin) on the development seed, with a POS paired as a manager
 * would pair it and the Owner signed in on it by PIN. The scan attacks every endpoint of the
 * OpenAPI document as that POS and Owner; endpoints for other kinds of device refuse them, which
 * the authorisation sweep (P8-03a) covers kind by kind.
 */
export async function startLocalServer(logFile: string): Promise<RunningTarget> {
  for (const built of [join(SERVER, 'dist', 'main.js'), join(CONSOLE, 'index.html')]) {
    if (!existsSync(built)) throw new Error(`${built} is missing: run pnpm build first`);
  }
  const cluster = await startTestDatabase({
    migrationsDir: join(SERVER, 'prisma', 'migrations'),
    prefix: 'dastpc',
  });
  const database = await cloneTemplateDatabase({
    adminUrl: cluster.adminUrl,
    templateDatabase: cluster.templateDatabase,
    runId: cluster.runId,
    prefix: 'dastpc',
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'rp-dast-pc-'));
  execFileSync(process.execPath, [join(SERVER, 'dist', 'database', 'seed-cli.js')], {
    env: { ...process.env, DATABASE_URL: database.url, RP_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  let deviceId: string;
  let ownerId: string;
  try {
    // A device token lasts a day here, so the scan never waits on one; and the POS takes as many
    // sign-ins a minute as the setting allows, since ZAP sends wrong PINs from it.
    await client.query(
      `INSERT INTO settings (id, restaurant_id, key, value, updated_at)
       SELECT gen_random_uuid(), id, setting.key, setting.value, now()
       FROM restaurants,
            (VALUES ('auth.deviceTokenMinutes', '1440'::jsonb),
                    ('auth.attemptsPerMinutePerDevice', '100'::jsonb)) AS setting (key, value)`,
    );
    const device = await client.query<{ id: string }>(
      `INSERT INTO devices (id, restaurant_id, type, name, status, public_key, key_algorithm,
                            paired_at, updated_at)
       SELECT gen_random_uuid(), id, 'POS', 'DAST POS', 'ACTIVE', $1, 'Ed25519', now(), now()
       FROM restaurants RETURNING id`,
      [publicKey.export({ format: 'pem', type: 'spki' }).toString()],
    );
    const owner = await client.query<{ id: string }>(
      'SELECT id FROM staff WHERE display_name = $1',
      [OWNER.name],
    );
    const [deviceRow] = device.rows;
    const [ownerRow] = owner.rows;
    if (deviceRow === undefined || ownerRow === undefined) throw new Error('The seed is not there');
    deviceId = deviceRow.id;
    ownerId = ownerRow.id;
  } finally {
    await client.end();
  }

  const port = await freePort();
  const base = `https://127.0.0.1:${String(port)}`;
  const child = startService(process.execPath, [join(SERVER, 'dist', 'main.js')], {
    env: {
      // `production` insists on the nightly backup and a licence; `test` stops the print queue.
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: database.url,
      RP_DATA_DIR: dataDir,
      RP_TLS: 'on',
      RP_MQTT: 'off',
      RP_BACKUPS: 'off',
      RP_CONSOLE_DIR: CONSOLE,
      LOG_LEVEL: 'warn',
    },
    logFile,
  });
  const stop = async () => {
    await stopService(child);
    await database.drop().catch(() => undefined);
    await cluster.stop();
  };
  try {
    const caFile = join(dataDir, 'tls', 'ca.crt');
    await waitUntil(
      'The local server',
      async () => {
        if (!existsSync(caFile)) return false;
        return (
          (await call(readFileSync(caFile, 'utf8'), 'GET', `${base}/api/v1/health`)).status === 200
        );
      },
      child,
    );
    const ca = readFileSync(caFile, 'utf8');
    const session = new ScanSession(ca, base, deviceId, ownerId, privateKey);
    await session.signIn();
    return {
      target: {
        name: 'local-server',
        baseUrl: base,
        pages: [`${base}/`, `${base}/pos`, `${base}/manage`, `${base}/ca.crt`],
        openApi: { file: 'openapi.json', targetUrl: base },
        exclude: [
          {
            url: `${escaped(base)}/api/v1/auth/logout`,
            why: "it would end the scan's own session; auth.int.test.ts covers signing out",
          },
          {
            url: `${escaped(base)}/socket\\.io/.*`,
            why: 'the real-time socket is WebSocket only; realtime.int.test.ts and P8-03c2 cover it',
          },
        ],
        activeScanMinutes: 20,
      },
      openApiSource: join(REPO, 'docs', 'api', 'openapi.json'),
      headerRules: () => [{ url: urlsUnder(base, '/api/'), headers: session.headers() }],
      keepFresh: () => session.keepFresh(),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The POS's device token and the Owner's session, renewed as the apps renew them. */
class ScanSession {
  private deviceToken = '';
  private accessToken = '';
  private refreshToken = '';
  private renewedAt = 0;

  constructor(
    private readonly ca: string,
    private readonly base: string,
    private readonly deviceId: string,
    private readonly ownerId: string,
    private readonly privateKey: KeyObject,
  ) {}

  headers(): Record<string, string> {
    return { [DEVICE_TOKEN_HEADER]: this.deviceToken, authorization: `Bearer ${this.accessToken}` };
  }

  private async newDeviceToken(): Promise<void> {
    const challenge = await call(this.ca, 'POST', `${this.base}/api/v1/devices/challenge`, {
      deviceId: this.deviceId,
    });
    const { challenge: value } = DeviceChallengeResponse.parse(challenge.body);
    const signature = sign(
      null,
      Buffer.from(deviceTokenMessage(this.deviceId, value), 'utf8'),
      this.privateKey,
    ).toString('base64');
    const answer = await call(this.ca, 'POST', `${this.base}/api/v1/devices/token`, {
      deviceId: this.deviceId,
      challenge: value,
      signature,
    });
    if (answer.status !== 200) throw new Error(`Device token: ${JSON.stringify(answer.body)}`);
    this.deviceToken = DeviceTokenResponse.parse(answer.body).deviceToken;
  }

  private take(body: unknown): void {
    const login = LoginResponse.parse(body);
    this.accessToken = login.accessToken;
    this.refreshToken = login.refreshToken;
    this.renewedAt = Date.now();
  }

  async signIn(): Promise<void> {
    await this.newDeviceToken();
    const answer = await call(
      this.ca,
      'POST',
      `${this.base}/api/v1/auth/pin-login`,
      { staffId: this.ownerId, pin: OWNER.pin },
      { [DEVICE_TOKEN_HEADER]: this.deviceToken },
    );
    if (answer.status !== 200) throw new Error(`Owner sign-in: ${JSON.stringify(answer.body)}`);
    this.take(answer.body);
  }

  /** A new access token before the old one ends, or a new sign-in when the session ended. */
  async keepFresh(): Promise<boolean> {
    const current = await call(
      this.ca,
      'GET',
      `${this.base}/api/v1/auth/session`,
      undefined,
      this.headers(),
    );
    if (current.status === 200 && Date.now() - this.renewedAt < RENEW_AFTER_MS) return false;
    if (current.status === 200) {
      const renewed = await call(
        this.ca,
        'POST',
        `${this.base}/api/v1/auth/refresh`,
        { refreshToken: this.refreshToken },
        { [DEVICE_TOKEN_HEADER]: this.deviceToken },
      );
      if (renewed.status === 200) {
        this.take(renewed.body);
        return true;
      }
    }
    await this.signIn();
    return true;
  }
}
