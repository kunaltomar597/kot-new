import { Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TlsCaResponse } from '@rp/contracts';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { localServerNames, serverTlsOptions, type TlsMaterial, TlsStore } from './tls-store.js';

/**
 * How often the server certificate is checked. Devices are configured with the server's address
 * (a DHCP reservation, BRD §10.4): when it changes (a new router), the certificate must cover the new
 * address within a minute. A check reads two small files; it writes only when renewing.
 */
const CHECK_INTERVAL_MS = 60_000;

/** Where the installation keeps its TLS material. */
export function tlsDirectory(config: Pick<AppConfig, 'dataDir'>): string {
  return join(config.dataDir, 'tls');
}

/**
 * LAN TLS at run time (ADR-0011): knows the CA (for the pairing QR code and `GET /tls/ca`) and
 * renews the server certificate in the running HTTPS server, without a restart, when it nears
 * expiry or the PC's addresses change.
 */
@Injectable()
export class TlsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TlsService.name);
  private readonly store: TlsStore;
  private material: TlsMaterial | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly renewedListeners = new Set<
    (options: ReturnType<typeof serverTlsOptions>) => void
  >();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_STORE) secrets: SecretStore,
    private readonly adapterHost: HttpAdapterHost,
  ) {
    this.store = new TlsStore(tlsDirectory(config), secrets);
  }

  get enabled(): boolean {
    return this.config.tls;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.renew();
    this.logger.log(
      { caSha256: this.material?.caFingerprint, names: this.material?.names },
      'Serving HTTPS with the installation CA',
    );
    this.timer = setInterval(() => {
      void this.renew().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Could not renew the server certificate');
      });
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * TLS options for another listener on this PC (the pagers' MQTTS broker, P2-04), loading the
   * material if needed; undefined without TLS.
   */
  async listenerOptions(): Promise<ReturnType<typeof serverTlsOptions> | undefined> {
    if (!this.enabled) return undefined;
    if (this.material === undefined) await this.renew();
    return this.material === undefined ? undefined : serverTlsOptions(this.material);
  }

  /** Called with the new options whenever the certificate is renewed. */
  onRenewed(listener: (options: ReturnType<typeof serverTlsOptions>) => void): () => void {
    this.renewedListeners.add(listener);
    return () => this.renewedListeners.delete(listener);
  }

  /** The CA's fingerprint for apps to pin; null without TLS. */
  caFingerprint(): string | null {
    return this.material?.caFingerprint ?? null;
  }

  /** The CA to pin or install; undefined without TLS. */
  ca(): TlsCaResponse | undefined {
    const material = this.material;
    if (material === undefined) return undefined;
    return {
      certificate: material.ca,
      sha256: material.caFingerprint,
      expiresAt: material.caExpiresAt.toISOString(),
    };
  }

  /**
   * Checks the server certificate and, if a new one was issued, hands it to the running server
   * (new connections use it at once). Returns whether it was renewed.
   */
  async renew(now: Date = new Date()): Promise<boolean> {
    const { material, renewed } = await this.store.ensure(
      localServerNames(this.config.tlsHostnames),
      now,
    );
    this.material = material;
    const adapter = this.adapterHost.httpAdapter as typeof this.adapterHost.httpAdapter | undefined;
    const server: unknown = adapter?.getHttpServer();
    if (renewed) {
      for (const listener of this.renewedListeners) listener(serverTlsOptions(material));
    }
    if (renewed && server instanceof HttpsServer) {
      server.setSecureContext(serverTlsOptions(material));
      this.logger.log(
        { expiresAt: material.expiresAt.toISOString(), names: material.names },
        'Renewed the server certificate',
      );
    }
    return renewed;
  }
}
