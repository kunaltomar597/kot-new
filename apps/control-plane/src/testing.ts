// `@rp/control-plane/testing`: what other packages' tests need to run a real Control Plane next
// to them (the local server's heartbeat acceptance test, P0-17b).
import { fileURLToPath } from 'node:url';

export { AdminService } from './admin/admin.service.js';
export { BillingService } from './billing/billing.service.js';
export { CloudBackupsService, OBJECT_STORE } from './cloud-backups/cloud-backups.service.js';
export { BackupEscrowService } from './cloud-backups/backup-escrow.service.js';
export { LocalObjectStore } from './cloud-backups/local-object-store.js';
export { DiagnosticsService } from './diagnostics/diagnostics.service.js';
export { FleetService } from './fleet/fleet.service.js';
export { LicencesService } from './licences/licences.service.js';
export { ReleasesService } from './releases/releases.service.js';
export { RemoteSettingsService } from './remote-settings/remote-settings.service.js';
export { SupportService } from './support/support.service.js';
export { createControlPlaneApp } from './app.factory.js';
export { type CpConfig, CpConfigSchema } from './config/cp-config.js';

/** The Control Plane's migrations, for a test database. */
export const CONTROL_PLANE_MIGRATIONS_DIR = fileURLToPath(
  new URL('../prisma/migrations', import.meta.url),
);
