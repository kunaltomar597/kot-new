import { z } from 'zod';
import { Id, Timestamp } from '../common.js';

/**
 * Remote configuration (UPD-010, P7-08c): vendor settings and feature flags the Control Plane
 * pushes to restaurant PCs, for the whole fleet and per PC. A PC applies them as vendor-controlled
 * settings its managers see but cannot change, and reports the digest of what it holds.
 */

/** First 16 hex digits of the SHA-256 of the values as canonical JSON. */
export const SettingsDigest = z.string().regex(/^[0-9a-f]{16}$/);

export const RemoteSettingValues = z.record(z.string().max(80), z.unknown());
export type RemoteSettingValues = z.infer<typeof RemoteSettingValues>;

/** A setting the vendor may push, as the web app edits it. */
export const RemoteSettingDefinition = z.object({
  key: z.string(),
  description: z.string(),
  defaultValue: z.unknown(),
  kind: z.enum(['BOOLEAN', 'INTEGER']),
  min: z.number().nullable(),
  max: z.number().nullable(),
  unit: z.string().nullable(),
});
export type RemoteSettingDefinition = z.infer<typeof RemoteSettingDefinition>;

export const FleetRemoteSettingsView = z.object({
  definitions: z.array(RemoteSettingDefinition),
  /** Values for every PC unless one sets its own; a key left out keeps the default. */
  fleet: RemoteSettingValues,
  updatedAt: Timestamp.nullable(),
});
export type FleetRemoteSettingsView = z.infer<typeof FleetRemoteSettingsView>;

export const InstallationRemoteSettingsView = z.object({
  installationId: Id,
  fleet: RemoteSettingValues,
  /** This PC's own values, over the fleet's. */
  overrides: RemoteSettingValues,
  /** What the PC should hold: the fleet's values with its own on top. */
  effective: RemoteSettingValues,
  digest: SettingsDigest,
  /** What the PC last reported holding; null before it applied any. */
  appliedDigest: SettingsDigest.nullable(),
  updatedAt: Timestamp.nullable(),
});
export type InstallationRemoteSettingsView = z.infer<typeof InstallationRemoteSettingsView>;

export const UpdateRemoteSettingsRequest = z.strictObject({
  values: RemoteSettingValues,
  reason: z.string().trim().min(3).max(200),
});
export type UpdateRemoteSettingsRequest = z.infer<typeof UpdateRemoteSettingsRequest>;

/** In a heartbeat answer: the values the PC should hold, while it does not (UPD-010). */
export const PushedSettings = z.object({ digest: SettingsDigest, values: RemoteSettingValues });
export type PushedSettings = z.infer<typeof PushedSettings>;
