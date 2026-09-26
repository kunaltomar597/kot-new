import { z } from 'zod';
import { Timestamp } from './common.js';

/** GET /api/v1/health: liveness and database status, used by the watchdog and support screen. */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  time: Timestamp,
  uptimeSeconds: z.int().nonnegative(),
  checks: z.object({
    database: z.object({
      status: z.enum(['up', 'down']),
      latencyMs: z.int().nonnegative(),
    }),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** GET /api/v1/version: component version for the support screen and N-1 checks (UPD-006). */
export const VersionResponse = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal('v1'),
  node: z.string().min(1),
  buildId: z.string().optional(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;

/**
 * The installation's LAN certificate authority (ADR-0011, SEC-001): apps pin it, browsers install
 * it once. Compare `sha256` with the fingerprint shown on the POS before trusting it.
 */
export const TlsCaResponse = z.object({
  /** PEM, to save as a `.crt` file. */
  certificate: z.string().startsWith('-----BEGIN CERTIFICATE-----'),
  /** SHA-256 fingerprint, `AB:CD:…` (32 bytes). */
  sha256: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
  /** When the CA expires (10 years after the installation created it). */
  expiresAt: Timestamp,
});
export type TlsCaResponse = z.infer<typeof TlsCaResponse>;
