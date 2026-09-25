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
