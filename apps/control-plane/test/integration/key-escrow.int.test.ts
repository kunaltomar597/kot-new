import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CloudRestoreResponse,
  FleetResponse,
  HeartbeatResponse,
  RestoreCodeView,
  StartCloudBackupResponse,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupEscrowService } from '../../src/cloud-backups/backup-escrow.service.js';
import { OBJECT_STORE } from '../../src/cloud-backups/cloud-backups.service.js';
import { wrapFor } from '../../src/cloud-backups/escrow-keys.js';
import { LocalObjectStore } from '../../src/cloud-backups/local-object-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

/**
 * Key escrow and restore from the cloud (P7-05e, DATA-003, DATA-004, OI-10): the PC escrows its
 * backup key when a heartbeat answer offers the escrow key; Support issues a one-time restore
 * code after verifying the Owner, who is told; the restore tool trades the code for the key,
 * wrapped for its own key, and the backups' download addresses.
 */

const vendorKey = generateKeyPairSync('rsa', { modulusLength: 3072 });
const backupKey = randomBytes(32);
const KEY_ID = createHash('sha256').update(backupKey).digest('hex').slice(0, 16);
let database: TestDatabase;
let app: INestApplication;
let pc: TestInstallation;
let empty: TestInstallation;
const tokens: Record<string, string> = {};
const as = (role: string) => bearer(tokens[role] ?? '');
const server = () => request(httpServer(app));

async function heartbeat(installation: TestInstallation, extra: Record<string, unknown> = {}) {
  const response = await signedPost(
    app,
    installation,
    '/v1/heartbeats',
    heartbeatBody({ backupKeyId: KEY_ID, ...extra }),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body);
}

/** A tool's own key pair, as the restore tool makes one. */
function toolKeys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    unwrap: (wrapped: string) =>
      privateDecrypt(
        { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(wrapped, 'base64'),
      ),
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(
    database.url,
    {
      escrowPrivateKey: vendorKey.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
    },
    [
      {
        provide: OBJECT_STORE,
        useValue: new LocalObjectStore(mkdtempSync(join(tmpdir(), 'cp-escrow-'))),
      },
    ],
  );
  for (const role of ['SUPPORT', 'READ_ONLY'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
  pc = await enrolledInstallation(app);
  empty = await enrolledInstallation(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[DATA-003] escrowing a PC’s backup key', () => {
  it('offers the escrow key until the PC’s key is escrowed, and stores only the wrapped key', async () => {
    const offered = (await heartbeat(pc)).backupKeyEscrow;
    expect(offered?.publicKey).toBe(
      vendorKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    );
    const wrappedKey = wrapFor(offered!.publicKey, backupKey).toString('base64');
    const body = JSON.stringify({ keyId: KEY_ID, escrowKeyId: offered!.escrowKeyId, wrappedKey });
    const stale = await request(httpServer(app))
      .put('/v1/backup-key-escrow')
      .set(
        pc.headers(
          'PUT',
          '/v1/backup-key-escrow',
          body.replace(offered!.escrowKeyId, '0'.repeat(16)),
        ),
      )
      .set('content-type', 'application/json')
      .send(body.replace(offered!.escrowKeyId, '0'.repeat(16)));
    expect([stale.status, ApiError.parse(stale.body).code]).toEqual([409, 'ESCROW_KEY_CHANGED']);
    const put = await request(httpServer(app))
      .put('/v1/backup-key-escrow')
      .set(pc.headers('PUT', '/v1/backup-key-escrow', body))
      .set('content-type', 'application/json')
      .send(body);
    expect(put.status, JSON.stringify(put.body)).toBe(204);
    const row = await app.get(PrismaService).backupKeyEscrow.findFirstOrThrow({
      where: { installationId: pc.id ?? '' },
    });
    expect(row.wrappedKey).not.toContain(backupKey.toString('base64'));
    expect((await heartbeat(pc)).backupKeyEscrow).toBeNull();
    // An opted-out PC sends no key id: nothing is offered.
    expect((await heartbeat(empty, { backupKeyId: null })).backupKeyEscrow).toBeNull();
    // The fleet view shows it escrowed.
    const fleet = FleetResponse.parse(
      (await server().get('/v1/vendor/fleet').set(as('READ_ONLY'))).body,
    );
    expect(
      fleet.installations.find((entry) => entry.installationId === pc.id)?.backupKeyEscrowedAt,
    ).not.toBeNull();
  });
});

describe('[DATA-004] [OI-10] restoring from the cloud with a restore code', () => {
  let code: string;

  it('issues a code only for Support, only with something to restore, and tells the Owner', async () => {
    const path = `/v1/vendor/installations/${pc.id ?? ''}/restore-codes`;
    const body = { reason: 'The PC was stolen', ownerVerification: 'Video call, Aadhaar seen' };
    expect((await server().post(path).set(as('READ_ONLY')).send(body)).status).toBe(403);
    const nothing = await server().post(path).set(as('SUPPORT')).send(body);
    expect([nothing.status, ApiError.parse(nothing.body).code]).toEqual([
      409,
      'NOTHING_TO_RESTORE',
    ]);

    // A cloud backup made with the escrowed key.
    const file = randomBytes(5_000);
    const started = StartCloudBackupResponse.parse(
      (
        await signedPost(
          app,
          pc,
          '/v1/cloud-backups',
          JSON.stringify({
            fileName: 'rp-backup-20261003T230000Z-nightly.rpbk',
            backupCreatedAt: '2026-10-03T23:00:00.000Z',
            sizeBytes: file.length,
            sha256: createHash('sha256').update(file).digest('hex'),
            keyId: KEY_ID,
          }),
        )
      ).body,
    );
    const put = await server()
      .put(started.parts[0]!.url)
      .set('content-type', 'application/octet-stream')
      .send(file);
    const done = await signedPost(
      app,
      pc,
      `/v1/cloud-backups/${started.id}/complete`,
      JSON.stringify({ parts: [{ number: 1, etag: String(put.headers.etag) }] }),
    );
    expect(done.status).toBe(200);

    const issued = await server().post(path).set(as('SUPPORT')).send(body);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    code = RestoreCodeView.parse(issued.body).code;
    const audit = await app.get(PrismaService).auditEntry.findFirstOrThrow({
      where: { action: 'restore_code.issued', targetId: pc.id ?? '' },
    });
    expect(audit.details).toMatchObject({ ownerVerification: 'Video call, Aadhaar seen' });
    expect(JSON.stringify(audit.details)).not.toContain(code);

    // The restaurant's Owner is told, until the PC says it has shown them.
    const [notice] = (await heartbeat(pc)).restoreCodes;
    expect(notice).toMatchObject({ reason: 'The PC was stolen' });
    expect((await heartbeat(pc, { restoreCodesSeen: [notice!.id] })).restoreCodes).toEqual([]);
  });

  it('releases the key, wrapped for the tool alone, once, with the backups to download', async () => {
    const tool = toolKeys();
    const wrong = await server()
      .post('/v1/cloud-restores')
      .send({ code: 'AAAA-BBBB-CCCC-DDDD', publicKey: tool.publicKey });
    expect([wrong.status, ApiError.parse(wrong.body).code]).toEqual([403, 'RESTORE_CODE_INVALID']);

    const released = await server()
      .post('/v1/cloud-restores')
      .send({ code: code.toLowerCase().replaceAll('-', ' '), publicKey: tool.publicKey });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const answer = CloudRestoreResponse.parse(released.body);
    expect(answer).toMatchObject({ installationId: pc.id, tenantName: 'Test Dhaba' });
    expect(answer.keys).toHaveLength(1);
    expect(tool.unwrap(answer.keys[0]!.wrappedKey).equals(backupKey)).toBe(true);
    expect(answer.backups.map((backup) => backup.fileName)).toEqual([
      'rp-backup-20261003T230000Z-nightly.rpbk',
    ]);
    const download = await server().get(answer.backups[0]!.url);
    expect(download.status).toBe(200);
    expect(
      await app.get(PrismaService).auditEntry.count({
        where: { action: 'backup_key.released', targetId: pc.id ?? '' },
      }),
    ).toBe(1);

    // Once only.
    const again = await server()
      .post('/v1/cloud-restores')
      .send({ code, publicKey: toolKeys().publicKey });
    expect(again.status).toBe(403);
  });

  it('refuses an expired code, and too many attempts from one address', async () => {
    const escrow = app.get(BackupEscrowService);
    const issued = await escrow.issueCode(
      pc.id ?? '',
      { reason: 'Test', ownerVerification: 'Phone call to the registered number' },
      { userId: '00000000-0000-7000-8000-000000000000', actor: 'vendor:test' },
      new Date(Date.now() - 25 * 60 * 60_000),
    );
    await expect(
      escrow.release({ code: issued.code, publicKey: toolKeys().publicKey }, 'address-a'),
    ).rejects.toMatchObject({ status: 403 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        escrow.release(
          { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', publicKey: toolKeys().publicKey },
          'address-b',
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    await escrow
      .release({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', publicKey: toolKeys().publicKey }, 'address-b')
      .catch(() => undefined);
    await expect(
      escrow.release({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', publicKey: toolKeys().publicKey }, 'address-b'),
    ).rejects.toMatchObject({ status: 429 });
  });
});
