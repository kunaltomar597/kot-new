import { createHash, randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CloudRestoreRequest,
  CloudRestoreResponse,
  EscrowBackupKeyRequest,
  EscrowOffer,
  RestoreCodeNotice,
  RestoreCodeRequest,
  RestoreCodeView,
} from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import { newId } from '../ids.js';
import { OBJECT_STORE } from './cloud-backups.service.js';
import { type EscrowKey, wrapFor } from './escrow-keys.js';
import type { ObjectStore } from './object-store.js';

export const ESCROW_KEY = Symbol('ESCROW_KEY');

/** Reads the vendor's escrow key when first needed (a KMS call in production); null when off. */
export type EscrowKeySource = () => Promise<EscrowKey | null>;

/** Restore codes: the enrolment codes' alphabet, without look-alikes (ADR-0012). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RESTORE_CODE_MS = 24 * 60 * 60_000;
/** Codes the restaurant's Owner is told about: those issued in the last week. */
const NOTICE_MS = 7 * 24 * 60 * 60_000;
const DOWNLOAD_SECONDS = 12 * 60 * 60;
const ATTEMPTS_PER_MINUTE = 5;

function compact(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashOf(code: string): string {
  return createHash('sha256').update(compact(code), 'utf8').digest('hex');
}

function newCode(): string {
  const characters = Array.from(
    { length: 16 },
    () => ALPHABET[randomInt(ALPHABET.length)] ?? 'A',
  ).join('');
  return [0, 4, 8, 12].map((start) => characters.slice(start, start + 4)).join('-');
}

const errors = {
  off: () => new CpError(503, 'ESCROW_OFF', 'Key escrow is not set up at the vendor yet.'),
  invalidCode: () =>
    new CpError(
      403,
      'RESTORE_CODE_INVALID',
      'That restore code is not valid, was used already or has expired. Ask the vendor for a new one.',
    ),
};

/**
 * Key escrow and restore from the cloud (DATA-003, DATA-004, OI-10, P7-05e).
 *
 * - Each PC wraps its backup key with the vendor's escrow public key (RSA-OAEP, SHA-256) when a
 *   heartbeat answer offers it; the Control Plane stores only the wrapped key, and the private
 *   half stays in the vendor's KMS.
 * - Vendor staff with BACKUP_RESTORE issue a one-time restore code once they have verified the
 *   Owner, with the reason and how. The restaurant's Owner is told at the next heartbeat.
 * - The restore tool on a new PC trades the code for the key, unwrapped by the KMS and wrapped
 *   again for the tool's own public key, and download addresses for the cloud backups.
 */
@Injectable()
export class BackupEscrowService {
  private readonly logger = new Logger(BackupEscrowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    @Inject(ESCROW_KEY) private readonly escrowKey: EscrowKeySource,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore | null,
  ) {}

  /** For a heartbeat answer: the escrow key, while this PC's backup key is not escrowed. */
  async offerFor(
    installationId: string,
    keyId: string | null | undefined,
  ): Promise<EscrowOffer | null> {
    if (keyId === null || keyId === undefined) return null;
    const held = await this.prisma.backupKeyEscrow.findUnique({
      where: { installationId_keyId: { installationId, keyId } },
      select: { id: true },
    });
    if (held !== null) return null;
    const key = await this.escrowKey().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'The escrow key could not be read');
      return null;
    });
    return key === null ? null : { escrowKeyId: key.id, publicKey: key.publicKey };
  }

  /** A PC's backup key, wrapped with the escrow key. Every key a PC ever used is kept. */
  async escrow(
    installationId: string,
    request: EscrowBackupKeyRequest,
    now = new Date(),
  ): Promise<void> {
    const key = await this.escrowKey();
    if (key === null) throw errors.off();
    if (request.escrowKeyId !== key.id) {
      throw new CpError(
        409,
        'ESCROW_KEY_CHANGED',
        'The vendor changed its escrow key. Wrap the backup key again with the new one.',
      );
    }
    await this.prisma.transaction(async (tx) => {
      const held = await tx.backupKeyEscrow.findUnique({
        where: { installationId_keyId: { installationId, keyId: request.keyId } },
        select: { id: true },
      });
      if (held !== null) return;
      await tx.backupKeyEscrow.create({
        data: {
          id: newId(),
          installationId,
          keyId: request.keyId,
          escrowKeyId: request.escrowKeyId,
          wrappedKey: request.wrappedKey,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        actor: `installation:${installationId}`,
        action: 'backup_key.escrowed',
        targetType: 'installation',
        targetId: installationId,
        details: { keyId: request.keyId, escrowKeyId: request.escrowKeyId },
      });
    });
  }

  /**
   * A one-time restore code (OI-10): only when there is something to restore, a cloud backup
   * whose key is escrowed. Audited with the reason and how the Owner was verified.
   */
  async issueCode(
    installationId: string,
    request: RestoreCodeRequest,
    principal: { readonly userId: string; readonly actor: string },
    now = new Date(),
  ): Promise<RestoreCodeView> {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      select: { id: true },
    });
    if (installation === null) {
      throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
    }
    if ((await this.restorable(installationId)).length === 0) {
      throw new CpError(
        409,
        'NOTHING_TO_RESTORE',
        'This PC has no cloud backup whose key is escrowed, so there is nothing to restore.',
      );
    }
    const code = newCode();
    const expiresAt = new Date(now.getTime() + RESTORE_CODE_MS);
    await this.prisma.transaction(async (tx) => {
      const issuer = await tx.vendorUser.findUnique({
        where: { id: principal.userId },
        select: { name: true },
      });
      const id = newId();
      await tx.restoreCode.create({
        data: {
          id,
          installationId,
          codeHash: hashOf(code),
          reason: request.reason,
          ownerVerification: request.ownerVerification,
          issuedBy: principal.actor,
          issuerName: issuer?.name ?? 'Vendor support',
          issuedAt: now,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        actor: principal.actor,
        action: 'restore_code.issued',
        targetType: 'installation',
        targetId: installationId,
        details: {
          restoreCodeId: id,
          reason: request.reason,
          ownerVerification: request.ownerVerification,
          expiresAt: expiresAt.toISOString(),
        },
      });
    });
    return { code, installationId, expiresAt: expiresAt.toISOString() };
  }

  /**
   * The restore tool on a new PC: the code (once, within its day) for the escrowed keys,
   * wrapped for the tool's public key, and the cloud backups with download addresses.
   */
  async release(
    request: CloudRestoreRequest,
    clientAddress: string,
    now = new Date(),
  ): Promise<CloudRestoreResponse> {
    if (!this.limiter.hit(`restore:${clientAddress}`, ATTEMPTS_PER_MINUTE, 60_000)) {
      throw new CpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Too many attempts from this address. Wait a minute and try again.',
      );
    }
    const key = await this.escrowKey();
    if (key === null || this.store === null) throw errors.off();
    // Used up atomically, so two tools can never both have it.
    const claimed = await this.prisma.restoreCode.updateManyAndReturn({
      where: { codeHash: hashOf(request.code), usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, usedFrom: clientAddress },
    });
    const code = claimed[0];
    if (code === undefined) throw errors.invalidCode();
    const installation = await this.prisma.installation.findUniqueOrThrow({
      where: { id: code.installationId },
      include: { tenant: { select: { name: true } } },
    });
    const backups = await this.restorable(code.installationId);
    const escrows = await this.prisma.backupKeyEscrow.findMany({
      where: {
        installationId: code.installationId,
        keyId: { in: [...new Set(backups.map((backup) => backup.keyId))] },
      },
    });
    const keys: CloudRestoreResponse['keys'] = [];
    for (const escrow of escrows) {
      const plain = await key.unwrap(Buffer.from(escrow.wrappedKey, 'base64'));
      keys.push({
        keyId: escrow.keyId,
        wrappedKey: wrapFor(request.publicKey, plain).toString('base64'),
      });
      plain.fill(0);
    }
    const listed: CloudRestoreResponse['backups'] = [];
    for (const backup of backups) {
      listed.push({
        fileName: backup.fileName,
        backupCreatedAt: backup.backupCreatedAt.toISOString(),
        sizeBytes: Number(backup.sizeBytes),
        sha256: backup.sha256,
        keyId: backup.keyId,
        url: await this.store.downloadUrl(backup.objectKey, DOWNLOAD_SECONDS),
      });
    }
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        actor: `restore-code:${code.id}`,
        action: 'backup_key.released',
        targetType: 'installation',
        targetId: code.installationId,
        details: {
          restoreCodeId: code.id,
          issuedBy: code.issuedBy,
          clientAddress,
          keyIds: keys.map((entry) => entry.keyId),
          backups: listed.length,
        },
      }),
    );
    return {
      installationId: installation.id,
      installationName: installation.name,
      tenantName: installation.tenant.name,
      keys,
      backups: listed,
      expiresAt: new Date(now.getTime() + DOWNLOAD_SECONDS * 1_000).toISOString(),
    };
  }

  /** For a heartbeat answer: codes issued this week the PC has not yet shown its Owner. */
  async noticesFor(
    installationId: string,
    seen: readonly string[] | undefined,
    now = new Date(),
  ): Promise<RestoreCodeNotice[]> {
    if (seen !== undefined && seen.length > 0) {
      await this.prisma.restoreCode.updateMany({
        where: { installationId, id: { in: [...seen] }, notifiedAt: null },
        data: { notifiedAt: now },
      });
    }
    const codes = await this.prisma.restoreCode.findMany({
      where: {
        installationId,
        notifiedAt: null,
        issuedAt: { gt: new Date(now.getTime() - NOTICE_MS) },
      },
      orderBy: { issuedAt: 'asc' },
      take: 20,
    });
    return codes.map((code) => ({
      id: code.id,
      issuedAt: code.issuedAt.toISOString(),
      issuedBy: code.issuerName,
      reason: code.reason,
    }));
  }

  /** The PC's cloud backups whose key is escrowed, newest first. */
  private async restorable(installationId: string) {
    const [backups, escrows] = await Promise.all([
      this.prisma.cloudBackup.findMany({
        where: { installationId, status: 'COMPLETE' },
        orderBy: { backupCreatedAt: 'desc' },
      }),
      this.prisma.backupKeyEscrow.findMany({
        where: { installationId },
        select: { keyId: true },
      }),
    ]);
    const held = new Set(escrows.map((escrow) => escrow.keyId));
    return backups.filter((backup) => held.has(backup.keyId));
  }
}
