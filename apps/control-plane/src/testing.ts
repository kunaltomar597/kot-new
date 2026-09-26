// `@rp/control-plane/testing`: what other packages' tests need to run a real Control Plane next
// to them (the local server's heartbeat acceptance test, P0-17b).
import { fileURLToPath } from 'node:url';

export { AdminService } from './admin/admin.service.js';
export { createControlPlaneApp } from './app.factory.js';
export { type CpConfig, CpConfigSchema } from './config/cp-config.js';

/** The Control Plane's migrations, for a test database. */
export const CONTROL_PLANE_MIGRATIONS_DIR = fileURLToPath(
  new URL('../prisma/migrations', import.meta.url),
);
