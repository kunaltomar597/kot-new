import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  APK_MEDIA_TYPE,
  ApiError,
  type AppBuildsFile,
  CLIENT_API_VERSION,
  CLIENT_HEADER,
  CurrentAppBuildResponse,
  type LoginResponse,
  SystemStatusResponse,
} from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppBuildsService } from '../../src/updates/app-builds.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  renewDeviceToken,
  signIn,
} from '../helpers/auth-kit.js';
import { api, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The phones' and tablets' APKs from the restaurant PC (WTR-001, UPD-001, UPD-007, P7-04e2): each
 * device gets its own app's build of the PC's release, checked against `apps.json` before it is
 * offered, also when the server no longer serves the app as it is.
 */

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;
let manager: LoginResponse;
let appsDir: string;
let phone: string;
let tablet: string;
let kds: string;

const waiterApk = randomBytes(256 * 1024);
const tabletApk = randomBytes(64 * 1024);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function writeBuilds(extra: Partial<AppBuildsFile> = {}) {
  const file: AppBuildsFile = {
    format: 1,
    release: '2.3.0',
    apps: [
      {
        kind: 'waiter-app',
        version: '1.5.0',
        clientApi: CLIENT_API_VERSION,
        file: 'waiter-app-1.5.0.apk',
        sha256: sha256(waiterApk),
        sizeBytes: waiterApk.length,
      },
      {
        kind: 'table-tablet',
        version: '1.5.0',
        clientApi: CLIENT_API_VERSION,
        file: 'table-tablet-1.5.0.apk',
        sha256: sha256(tabletApk),
        sizeBytes: tabletApk.length,
      },
    ],
    ...extra,
  };
  writeFileSync(join(appsDir, 'apps.json'), JSON.stringify(file));
}

beforeAll(async () => {
  appsDir = mkdtempSync(join(tmpdir(), 'rp-apps-'));
  writeFileSync(join(appsDir, 'waiter-app-1.5.0.apk'), waiterApk);
  writeFileSync(join(appsDir, 'table-tablet-1.5.0.apk'), tabletApk);
  writeBuilds();
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, config: { appsDir } });
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  phone = await addDevice(app, kit, 'WAITER_PHONE');
  tablet = await addDevice(app, kit, 'TABLE_TABLET');
  kds = await addDevice(app, kit, 'KDS');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const buildOf = async (deviceId: string, headers: Record<string, string> = {}) => {
  const response = await api(app)
    .get('/api/v1/devices/current/app-build')
    .set({ ...authHeaders(deviceId), ...headers });
  expect(response.status).toBe(200);
  return CurrentAppBuildResponse.parse(response.body).build;
};

const download = (deviceId: string, headers: Record<string, string> = {}) =>
  api(app)
    .get('/api/v1/devices/current/app-build/apk')
    .set({ ...authHeaders(deviceId), ...headers })
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        done(null, Buffer.concat(chunks));
      });
    });

describe('[WTR-001] [UPD-001] each phone and tablet gets its own app from the PC', () => {
  it('describes the waiter app to a phone and the tablet app to a tablet', async () => {
    expect(await buildOf(phone)).toEqual({
      kind: 'waiter-app',
      version: '1.5.0',
      clientApi: CLIENT_API_VERSION,
      sha256: sha256(waiterApk),
      sizeBytes: waiterApk.length,
    });
    expect((await buildOf(tablet))?.kind).toBe('table-tablet');
  });

  it('[UPD-007] sends the APK whose SHA-256 it described', async () => {
    const response = await download(phone);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(APK_MEDIA_TYPE);
    expect(response.headers['content-disposition']).toContain('waiter-app-1.5.0.apk');
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.body as Buffer;
    expect(body.length).toBe(waiterApk.length);
    expect(sha256(body)).toBe(sha256(waiterApk));
    expect(sha256((await download(tablet)).body as Buffer)).toBe(sha256(tabletApk));
  });

  it('offers nothing to a device that is not a phone or tablet, or not paired', async () => {
    expect(await buildOf(kds)).toBeNull();
    const none = await download(kds);
    expect(none.status).toBe(404);
    expect(ApiError.parse(JSON.parse((none.body as Buffer).toString('utf8'))).code).toBe(
      'NO_APP_BUILD',
    );
    const anonymous = await api(app).get('/api/v1/devices/current/app-build');
    expect(anonymous.status).toBe(401);
    const anonymousApk = await api(app).get('/api/v1/devices/current/app-build/apk');
    expect(anonymousApk.status).toBe(401);
  });

  it('[UPD-006] lets an app the server no longer serves renew its token and fetch its update', async () => {
    const tooOld = { [CLIENT_HEADER]: 'waiter-app/0.9.0 api/0.9' };
    const refused = await api(app)
      .get('/api/v1/auth/staff-tiles')
      .set({ ...authHeaders(phone), ...tooOld });
    expect(refused.status).toBe(426);
    await renewDeviceToken(app, phone, tooOld);
    expect((await buildOf(phone, tooOld))?.version).toBe('1.5.0');
    expect((await download(phone, tooOld)).status).toBe(200);
  });
});

describe('[UPD-007] the PC checks each APK before offering it', () => {
  it('shows the builds with their state on the System page', async () => {
    const response = await api(app)
      .get('/api/v1/system')
      .set(authHeaders(kit.deviceId, manager.accessToken));
    expect(response.status).toBe(200);
    const status = SystemStatusResponse.parse(response.body);
    expect(status.clients.builds.map((build) => [build.kind, build.status])).toEqual([
      ['waiter-app', 'OK'],
      ['table-tablet', 'OK'],
    ]);
  });

  it('stops offering an APK that changed on disk, and offers it again once it matches', async () => {
    const path = join(appsDir, 'waiter-app-1.5.0.apk');
    const changed = Buffer.from(waiterApk);
    changed[100] = (changed[100] ?? 0) ^ 0xff;
    writeFileSync(path, changed);
    expect(await buildOf(phone)).toBeNull();
    expect((await download(phone)).status).toBe(404);
    const builds = await app.get(AppBuildsService).list();
    expect(builds.map((build) => build.status)).toEqual(['DAMAGED', 'OK']);

    writeFileSync(path, waiterApk);
    expect((await buildOf(phone))?.version).toBe('1.5.0');
  });

  it('marks an APK that is not there, and offers nothing from a broken apps.json', async () => {
    writeFileSync(
      join(appsDir, 'apps.json'),
      JSON.stringify({
        format: 1,
        release: '2.3.1',
        apps: [
          {
            kind: 'waiter-app',
            version: '1.6.0',
            clientApi: CLIENT_API_VERSION,
            file: 'waiter-app-1.6.0.apk',
            sha256: sha256(waiterApk),
            sizeBytes: waiterApk.length,
          },
        ],
      }),
    );
    expect(await buildOf(phone)).toBeNull();
    expect((await app.get(AppBuildsService).list()).map((build) => build.status)).toEqual([
      'MISSING',
    ]);

    writeFileSync(join(appsDir, 'apps.json'), '{"format":1,"apps":[{"file":"../x"}]}');
    expect(await app.get(AppBuildsService).list()).toEqual([]);
    writeBuilds();
    expect((await buildOf(tablet))?.kind).toBe('table-tablet');
  });
});
