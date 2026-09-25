import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';

export type TransactionClient = Prisma.TransactionClient;

export interface TransactionOptions {
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Maximum time to wait for a connection from the pool, in ms. */
  readonly maxWait?: number;
  /** Maximum time the transaction may run, in ms. */
  readonly timeout?: number;
}

export interface DatabasePing {
  readonly up: boolean;
  readonly latencyMs: number;
}

/**
 * The Prisma client for the local PostgreSQL database, using the `pg` driver adapter
 * (Prisma 7, no query engine binary). One instance per server process.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
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

  /**
   * Runs `work` in one database transaction. State changes, their audit entry and their outbox
   * event are always written together this way (NFR-A03, CONVENTIONS "Persistence").
   */
  async transaction<T>(
    work: (tx: TransactionClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return this.$transaction(work, {
      maxWait: options.maxWait ?? 5_000,
      timeout: options.timeout ?? 15_000,
      ...(options.isolationLevel !== undefined && { isolationLevel: options.isolationLevel }),
    });
  }

  /** Checks the database answers, for the health endpoint. Never throws. */
  async ping(): Promise<DatabasePing> {
    const started = performance.now();
    try {
      await this.$queryRaw`SELECT 1`;
      return { up: true, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { up: false, latencyMs: Math.round(performance.now() - started) };
    }
  }
}
