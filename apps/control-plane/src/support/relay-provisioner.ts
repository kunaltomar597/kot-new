import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';

/** Injection token for the `RelayProvisioner`. */
export const RELAY_PROVISIONER = Symbol('RELAY_PROVISIONER');

/**
 * What the Control Plane does in the QR relay (VCP-002): create (or rename) a restaurant, add a
 * scoped credential (the relay keeps only its SHA-256) and revoke one. Through the relay's own
 * functions, as its `relay_provisioner` role, never its tables.
 */
export interface RelayProvisioner {
  readonly configured: boolean;
  provision(tenantId: string, name: string, secretHash: Buffer, label: string): Promise<string>;
  revoke(credentialId: string): Promise<void>;
}

@Injectable()
export class PgRelayProvisioner implements RelayProvisioner, OnModuleDestroy {
  private pool: pg.Pool | undefined;

  constructor(@Inject(CP_CONFIG) private readonly config: CpConfig) {}

  get configured(): boolean {
    return this.config.relayDatabaseUrl !== undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /** The restaurant (created or renamed) and a new credential; returns the credential's id. */
  async provision(
    tenantId: string,
    name: string,
    secretHash: Buffer,
    label: string,
  ): Promise<string> {
    return this.inRole(async (client) => {
      await client.query('SELECT relay.provision_tenant($1, $2)', [tenantId, name]);
      const result = await client.query<{ id: string }>(
        'SELECT relay.add_credential($1, $2, $3) AS id',
        [tenantId, secretHash, label],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('The relay did not add the credential');
      return id;
    });
  }

  async revoke(credentialId: string): Promise<void> {
    await this.inRole((client) =>
      client.query('SELECT relay.revoke_credential($1)', [credentialId]),
    );
  }

  private async inRole<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const url = this.config.relayDatabaseUrl;
    if (url === undefined) throw new Error('CP_RELAY_DATABASE_URL is not set');
    this.pool ??= new pg.Pool({ connectionString: url, max: 2 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE relay_provisioner');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
