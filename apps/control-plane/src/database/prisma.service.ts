import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';

export type TransactionClient = Prisma.TransactionClient;

/** The Prisma client for the Control Plane database (pg driver adapter, no engine binary). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(CP_CONFIG) config: CpConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Runs `work` in one transaction: a change and its audit entry are written together. */
  transaction<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(work, { maxWait: 5_000, timeout: 15_000 });
  }

  /** Checks the database answers, for the health endpoint. Never throws. */
  async ping(): Promise<{ up: boolean; latencyMs: number }> {
    const started = performance.now();
    try {
      await this.$queryRaw`SELECT 1`;
      return { up: true, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { up: false, latencyMs: Math.round(performance.now() - started) };
    }
  }
}
