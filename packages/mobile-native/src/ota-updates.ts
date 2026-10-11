import type { OtaCheck, OtaFetch, OtaUpdateSource } from '@rp/mobile-core';

/** The part of `expo-updates` the apps use. */
export interface ExpoUpdatesModule {
  readonly isEnabled: boolean;
  readonly isEmergencyLaunch: boolean;
  readonly emergencyLaunchReason: string | null;
  checkForUpdateAsync(): Promise<{
    isAvailable: boolean;
    isRollBackToEmbedded: boolean;
    manifest?: unknown;
  }>;
  fetchUpdateAsync(): Promise<{
    isNew: boolean;
    isRollBackToEmbedded: boolean;
    manifest?: unknown;
  }>;
  reloadAsync(): Promise<void>;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The client API an update speaks: the app config's `extra.clientApi` when it was published
 * (`app.config.ts` reads it from `@rp/contracts`), which EAS keeps in the update's manifest as
 * `extra.expoClient.extra.clientApi`.
 */
export function clientApiOfManifest(manifest: unknown): string | undefined {
  const clientApi = field(
    field(field(field(manifest, 'extra'), 'expoClient'), 'extra'),
    'clientApi',
  );
  return typeof clientApi === 'string' ? clientApi : undefined;
}

function updateOf(manifest: unknown): Extract<OtaCheck, { kind: 'update' }> | undefined {
  const id = field(manifest, 'id');
  return typeof id === 'string'
    ? { kind: 'update', id, clientApi: clientApiOfManifest(manifest) }
    : undefined;
}

/**
 * EAS Update through `expo-updates` (UPD-001, UPD-007, P7-04e1) as `@rp/mobile-core`'s
 * `OtaUpdateSource`. The apps are built with `checkAutomatically: NEVER`, so only the
 * `OtaUpdater` checks, after asking the restaurant's server which client API it speaks. A preview
 * or production build carries the update signing certificate, and `expo-updates` refuses an
 * update whose signature does not verify against it. Load it once with `ExpoOtaUpdates.load()`.
 */
export class ExpoOtaUpdates implements OtaUpdateSource {
  constructor(private readonly updates: ExpoUpdatesModule) {}

  static async load(): Promise<ExpoOtaUpdates> {
    const updates = await import('expo-updates');
    return new ExpoOtaUpdates(updates);
  }

  get enabled(): boolean {
    return this.updates.isEnabled;
  }

  get emergencyLaunchReason(): string | null {
    return this.updates.isEmergencyLaunch
      ? (this.updates.emergencyLaunchReason ?? 'unknown')
      : null;
  }

  async check(): Promise<OtaCheck> {
    const result = await this.updates.checkForUpdateAsync();
    if (result.isRollBackToEmbedded) return { kind: 'rollback' };
    return (result.isAvailable ? updateOf(result.manifest) : undefined) ?? { kind: 'none' };
  }

  async fetch(): Promise<OtaFetch> {
    const result = await this.updates.fetchUpdateAsync();
    if (result.isRollBackToEmbedded) return { kind: 'rollback' };
    return (result.isNew ? updateOf(result.manifest) : undefined) ?? { kind: 'none' };
  }

  reload(): Promise<void> {
    return this.updates.reloadAsync();
  }
}
