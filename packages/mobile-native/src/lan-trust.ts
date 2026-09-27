import type { ServerAuthority, ServerTrust } from '@rp/mobile-core';

/** The native half (`RpLanTrustModule.kt`, `LanTrust.kt`): the LAN CA pinned for the server. */
export interface LanTrustNative {
  fetchAuthority(serverUrl: string): Promise<ServerAuthority>;
  pin(certificate: string, serverUrl: string): Promise<string>;
  pinned(): Promise<string | null>;
  clear(): Promise<void>;
}

async function nativeModule(): Promise<LanTrustNative> {
  const { requireNativeModule } = await import('expo');
  return requireNativeModule<LanTrustNative>('RpLanTrust');
}

/**
 * The restaurant's LAN CA pinned in the device's HTTP and WebSocket clients (ADR-0011, SEC-010).
 * `fetchAuthority` downloads a server's CA without trusting the connection, `pin` makes it the only
 * CA trusted for that server from then on (also after a restart), and `clear` forgets it when the
 * device is unpaired.
 */
export class AndroidServerTrust implements ServerTrust {
  constructor(private readonly native: () => Promise<LanTrustNative> = nativeModule) {}

  async fetchAuthority(serverUrl: string): Promise<ServerAuthority> {
    const { certificate, sha256 } = await (await this.native()).fetchAuthority(serverUrl);
    return { certificate, sha256 };
  }

  async pin(certificate: string, serverUrl: string): Promise<string> {
    return (await this.native()).pin(certificate, serverUrl);
  }

  /** The pinned CA's fingerprint, or undefined while the device is not paired over TLS. */
  async pinned(): Promise<string | undefined> {
    return (await (await this.native()).pinned()) ?? undefined;
  }

  async clear(): Promise<void> {
    await (await this.native()).clear();
  }
}
