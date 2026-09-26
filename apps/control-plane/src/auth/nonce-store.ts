import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

const PURGE_INTERVAL_MS = 10 * 60_000;

/**
 * Remembers each signed request's nonce per installation until its timestamp leaves the accepted
 * window, so a captured request cannot be replayed (ADR-0012). Expired nonces are purged.
 */
@Injectable()
export class NonceStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NonceStore.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.purge().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Could not purge expired nonces; retrying later');
      });
    }, PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Records the nonce; false when this installation already used it. */
  async use(installationId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const { count } = await this.prisma.requestNonce.createMany({
      data: [{ installationId, nonce, expiresAt }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async purge(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.requestNonce.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}
