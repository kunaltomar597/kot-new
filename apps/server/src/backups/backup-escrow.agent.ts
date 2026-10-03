import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { HeartbeatResponse } from '@rp/contracts/control-plane';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { backupKeyId } from './backup-file.js';
import { readRestoreCodesSeen, saveEscrowedKey, saveRestoreCodesSeen } from './escrow-state.js';

/** Wraps a secret for an RSA public key (SPKI DER, base64) with RSA-OAEP and SHA-256. */
export function wrapForEscrow(publicKeySpkiBase64: string, secret: Buffer): Buffer {
  const key = createPublicKey({
    key: Buffer.from(publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    secret,
  );
}

/**
 * Key escrow on the restaurant's side (DATA-003, OI-10, P7-05e), from each heartbeat answer:
 *
 * - when the Control Plane offers the vendor's escrow key, the backup key is wrapped with it
 *   (RSA-OAEP, SHA-256) and sent; only the vendor's KMS can unwrap it, for a restore code;
 * - when vendor staff issued a restore code for this restaurant's backups, the Owner is alerted
 *   (`VENDOR_RESTORE_CODE`), and the next heartbeat says so.
 */
@Injectable()
export class BackupEscrowAgent implements OnModuleInit {
  private readonly logger = new Logger(BackupEscrowAgent.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: HeartbeatService,
    private readonly notifications: NotificationsService,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  onModuleInit(): void {
    this.heartbeat.onAnswer((answer) => this.received(answer));
  }

  async received(answer: HeartbeatResponse): Promise<void> {
    await this.notify(answer.restoreCodes);
    if (answer.backupKeyEscrow !== null) await this.escrow(answer.backupKeyEscrow);
  }

  private async escrow(offer: NonNullable<HeartbeatResponse['backupKeyEscrow']>): Promise<void> {
    const connection = await this.heartbeat.connection();
    if ('unavailable' in connection) return;
    const key = await this.secrets.get('backup-key');
    const keyId = backupKeyId(key);
    await connection.client.escrowBackupKey(connection.installationId, {
      keyId,
      escrowKeyId: offer.escrowKeyId,
      wrappedKey: wrapForEscrow(offer.publicKey, key).toString('base64'),
    });
    await saveEscrowedKey(this.prisma, {
      keyId,
      escrowKeyId: offer.escrowKeyId,
      at: new Date().toISOString(),
    });
    this.logger.log({ keyId }, 'The backup key is escrowed with the vendor');
  }

  /** Alerts the Owner about each new restore code; keeps the ids to report as seen. */
  private async notify(notices: HeartbeatResponse['restoreCodes']): Promise<void> {
    const seen = await readRestoreCodesSeen(this.prisma);
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true } });
    const fresh = notices.filter((notice) => !seen.includes(notice.id));
    if (fresh.length > 0 && restaurants.length > 0) {
      await this.prisma.transaction(async (tx) => {
        for (const notice of fresh) {
          for (const { id } of restaurants) {
            await this.notifications.raise(tx, {
              restaurantId: id,
              type: 'VENDOR_RESTORE_CODE',
              dedupeKey: `restore-code:${notice.id}`,
              payload: {
                restoreCodeId: notice.id,
                issuedAt: notice.issuedAt,
                issuedBy: notice.issuedBy,
                reason: notice.reason,
              },
            });
          }
        }
      });
      this.logger.warn({ count: fresh.length }, 'The vendor issued a restore code for the backups');
    }
    // Reported as seen until the Control Plane stops sending them.
    const told = restaurants.length > 0 ? fresh.map((notice) => notice.id) : [];
    await saveRestoreCodesSeen(this.prisma, [
      ...seen.filter((id) => notices.some((notice) => notice.id === id)),
      ...told,
    ]);
  }
}
