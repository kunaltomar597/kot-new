import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QrMenuDocument } from '@rp/contracts/relay';
import { BROWSER_ID_HEADER, TABLE_TOKEN_HEADER } from '@rp/contracts/relay';
import { MENU } from '@rp/ordering/testing';
import { RELAY_MIGRATIONS_DIR, startRelay, SUPABASE_PRELUDE } from '@rp/relay/testing';
import { startTestDatabase } from '@rp/test-postgres';
import { escaped, type HeaderRule, urlsUnder } from '../credentials.js';
import {
  freePort,
  REPO,
  type RunningTarget,
  startService,
  stopService,
  waitUntil,
} from './common.js';

/** A table code the scan uses that is in no restaurant: the site answers it "not in use". */
const UNKNOWN_TABLE = 'AAAAAAAAAAAAAAAAAAAAAA';

/**
 * The QR relay as a deployment has it (its functions on a local port, a throwaway PostgreSQL with
 * Supabase's roles): the diners' restaurant with a table, a published menu and the PC present,
 * and a second restaurant whose PC credential the scan attacks the PCs' function with, so what
 * that does to its own restaurant (a menu replaced, tables removed) never reaches the diners'.
 */
export interface RelaySetup {
  /** `http://127.0.0.1:<port>`; the functions are under `/functions/v1`. */
  readonly origin: string;
  readonly functionsUrl: string;
  /** Where the QR site will answer, the only origin the diners' functions allow. */
  readonly siteOrigin: string;
  readonly sitePort: number;
  readonly tableToken: string;
  readonly pcCredential: string;
  stop(): Promise<void>;
}

function menuDocument(): QrMenuDocument {
  return {
    restaurantName: 'Spice Route',
    accentColor: '#B4232A',
    timeZone: 'Asia/Kolkata',
    instructionMaxLength: 140,
    priceMode: 'TAX_EXCLUSIVE',
    serviceRequests: true,
    menu: {
      ...MENU,
      items: MENU.items.map((item) => ({
        ...item,
        channels: [...new Set([...item.channels, 'QR' as const])],
      })),
    },
    photos: [],
  };
}

const PRESENCE = {
  serverVersion: '1.0.0',
  settings: {
    submissionsPerWindow: 5,
    rateLimitWindowMinutes: 10,
    pickupTimeoutSeconds: 60,
    presenceIntervalSeconds: 30,
    readOnlyAfterSeconds: 120,
  },
};

export async function startRelaySetup(): Promise<RelaySetup> {
  const cluster = await startTestDatabase({
    migrationsDir: RELAY_MIGRATIONS_DIR,
    prefix: 'dast',
    preludeFiles: [SUPABASE_PRELUDE],
  });
  const sitePort = await freePort();
  const siteOrigin = `http://127.0.0.1:${String(sitePort)}`;
  // With Realtime, as deployed: PCs ask for a session to hear of new orders at once (P5-03d).
  const relay = await startRelay({
    adminUrl: cluster.adminUrl,
    runId: cluster.runId,
    allowedOrigins: [siteOrigin],
    realtimeJwtSecret: randomBytes(32).toString('base64url'),
  });
  const asPc = async (credential: string, method: string, path: string, body: unknown) => {
    const response = await fetch(`${relay.baseUrl}/server/${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`relay ${path}: ${String(response.status)} ${await response.text()}`);
    }
  };
  const diners = await relay.provision('Spice Route');
  const tableToken = randomBytes(16).toString('base64url');
  await asPc(diners.credential, 'POST', 'presence', PRESENCE);
  await asPc(diners.credential, 'PUT', 'tables', {
    tables: [
      {
        tableId: randomUUID(),
        label: 'T1',
        tokenHash: createHash('sha256').update(tableToken, 'utf8').digest('hex'),
        active: true,
      },
    ],
  });
  await asPc(diners.credential, 'PUT', 'menu', { version: 1, document: menuDocument() });
  const scanned = await relay.provision('Scanned PC');
  await asPc(scanned.credential, 'POST', 'presence', PRESENCE);
  const origin = new URL(relay.baseUrl).origin;
  return {
    origin,
    functionsUrl: relay.baseUrl,
    siteOrigin,
    sitePort,
    tableToken,
    pcCredential: scanned.credential,
    async stop() {
      await relay.stop();
      await cluster.stop();
    },
  };
}

/** The relay's functions, attacked through their OpenAPI document. */
export function relayTarget(setup: RelaySetup): RunningTarget {
  const diners = `${urlsUnder(setup.origin, '/functions/v1/')}(qr-menu|submit-order|order-status|service-request)`;
  return {
    target: {
      name: 'relay',
      baseUrl: setup.origin,
      pages: [],
      openApi: { file: 'relay.openapi.json', targetUrl: setup.origin },
      exclude: [
        {
          url: `${escaped(setup.origin)}/storage/.*`,
          why: "the test relay's stand-in for Supabase Storage, not the relay's code",
        },
      ],
      activeScanMinutes: 10,
    },
    openApiSource: join(REPO, 'docs', 'api', 'relay.openapi.json'),
    headerRules: (): HeaderRule[] => [
      {
        url: diners,
        headers: {
          [TABLE_TOKEN_HEADER]: setup.tableToken,
          [BROWSER_ID_HEADER]: 'dast-browser-0001',
        },
      },
      {
        url: urlsUnder(setup.origin, '/functions/v1/server'),
        headers: { authorization: `Bearer ${setup.pcCredential}` },
      },
    ],
    keepFresh: () => Promise.resolve(false),
    stop: () => Promise.resolve(),
  };
}

/** The built QR site (`next start`), pointed at the relay, on the port the relay allows. */
export async function startQrSite(setup: RelaySetup, logFile: string): Promise<RunningTarget> {
  const site = join(REPO, 'apps', 'qr-menu');
  if (!existsSync(join(site, '.next', 'BUILD_ID'))) {
    throw new Error('The QR site is not built: run pnpm build first');
  }
  const child = startService(
    process.execPath,
    [
      join(site, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'start',
      '--port',
      String(setup.sitePort),
      '--hostname',
      '127.0.0.1',
    ],
    {
      cwd: site,
      env: { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', RELAY_URL: setup.functionsUrl },
      logFile,
    },
  );
  const base = setup.siteOrigin;
  await waitUntil('The QR site', async () => (await fetch(`${base}/privacy`)).ok, child);
  return {
    target: {
      name: 'qr-site',
      baseUrl: base,
      pages: [
        `${base}/`,
        `${base}/t/${setup.tableToken}`,
        `${base}/privacy`,
        `${base}/terms`,
        `${base}/t/${UNKNOWN_TABLE}`,
      ],
      exclude: [],
      activeScanMinutes: 5,
    },
    headerRules: () => [],
    keepFresh: () => Promise.resolve(false),
    stop: () => stopService(child),
  };
}
