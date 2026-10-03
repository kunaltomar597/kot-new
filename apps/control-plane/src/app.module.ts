import type { IncomingMessage } from 'node:http';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AdminService } from './admin/admin.service.js';
import { AuditService } from './audit/audit.service.js';
import { InstallationGuard } from './auth/installation.guard.js';
import { NonceStore } from './auth/nonce-store.js';
import { RateLimiter } from './auth/rate-limiter.js';
import { CP_CONFIG, type CpConfig } from './config/cp-config.js';
import { PrismaService } from './database/prisma.service.js';
import { CpExceptionFilter } from './errors/cp-exception.filter.js';
import { CP_ERROR_REPORTER, errorReporterFor } from './errors/error-reporting.js';
import { HealthController } from './health/health.controller.js';
import { HeartbeatsController } from './heartbeats/heartbeats.controller.js';
import { HeartbeatsService } from './heartbeats/heartbeats.service.js';
import { LicenceSigner } from './licences/licence-signer.js';
import { LicencesService } from './licences/licences.service.js';
import { FleetAdminController } from './admin/fleet-admin.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { CloudBackupsController } from './cloud-backups/cloud-backups.controller.js';
import { CloudBackupsService, OBJECT_STORE } from './cloud-backups/cloud-backups.service.js';
import { objectStoreFor } from './cloud-backups/object-store-for.js';
import { BackupEscrowService, ESCROW_KEY } from './cloud-backups/backup-escrow.service.js';
import { escrowKeySourceFor } from './cloud-backups/escrow-keys.js';
import { ALERT_NOTIFIER, alertNotifierFor } from './fleet/alert-notifier.js';
import { DiagnosticsController } from './diagnostics/diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics/diagnostics.service.js';
import { FleetController } from './fleet/fleet.controller.js';
import { FleetService } from './fleet/fleet.service.js';
import { RemoteSettingsController } from './remote-settings/remote-settings.controller.js';
import { RemoteSettingsService } from './remote-settings/remote-settings.service.js';
import { PgRelayProvisioner, RELAY_PROVISIONER } from './support/relay-provisioner.js';
import { SupportController } from './support/support.controller.js';
import { SupportService } from './support/support.service.js';
import { FleetAdminService } from './admin/fleet-admin.service.js';
import { VendorAuthService } from './vendor/vendor-auth.service.js';
import { VendorController } from './vendor/vendor.controller.js';
import { VendorGuard } from './vendor/vendor.guard.js';
import { EnrolmentController } from './installations/enrolment.controller.js';
import { InstallationsService } from './installations/installations.service.js';
import { MenuExtractionsController } from './menu-import/menu-extractions.controller.js';
import { MenuExtractionsService } from './menu-import/menu-extractions.service.js';
import {
  AnthropicMenuExtractor,
  MENU_EXTRACTOR,
  type MenuExtractor,
  NO_MENU_EXTRACTOR,
} from './menu-import/menu-extractor.js';
import { ReleasesService } from './releases/releases.service.js';
import { UpdatesController } from './releases/updates.controller.js';

/** Never logged: signatures, enrolment codes and proofs (SEC-015). */
const REDACTED = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'req.headers["x-rp-signature"]',
  'code',
  '*.code',
  'proof',
  '*.proof',
];

/** The AI provider for menu import, when its key is set (SEC-002); otherwise import is off. */
function menuExtractorFor(config: CpConfig): MenuExtractor {
  return config.aiApiKey === undefined
    ? NO_MENU_EXTRACTOR
    : new AnthropicMenuExtractor({
        apiKey: config.aiApiKey,
        model: config.aiModel,
        baseUrl: config.aiBaseUrl,
        timeoutMs: config.aiTimeoutSeconds * 1_000,
      });
}

/**
 * The Vendor Control Plane (ADR-0012). One module while it is this small; P7 work packages split
 * it by area (tenants, licences, fleet, releases).
 */
@Module({})
export class ControlPlaneModule {
  static forRoot(config: CpConfig): DynamicModule {
    return {
      module: ControlPlaneModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.logLevel,
            // correlationMiddleware assigned req.id already.
            genReqId: (request: IncomingMessage) => {
              const id = (request as IncomingMessage & { id?: unknown }).id;
              return typeof id === 'string' ? id : 'unknown';
            },
            customProps: (request: IncomingMessage) => {
              const id = (request as IncomingMessage & { id?: unknown }).id;
              return typeof id === 'string' ? { correlationId: id } : {};
            },
            redact: { paths: REDACTED, censor: '[REDACTED]' },
            ...(config.logPretty && config.env === 'development'
              ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
              : {}),
          },
        }),
      ],
      controllers: [
        HealthController,
        EnrolmentController,
        HeartbeatsController,
        UpdatesController,
        MenuExtractionsController,
        VendorController,
        FleetAdminController,
        BillingController,
        SupportController,
        FleetController,
        DiagnosticsController,
        RemoteSettingsController,
        CloudBackupsController,
      ],
      providers: [
        { provide: CP_CONFIG, useValue: config },
        PrismaService,
        AuditService,
        RateLimiter,
        NonceStore,
        InstallationsService,
        HeartbeatsService,
        LicenceSigner,
        LicencesService,
        VendorAuthService,
        FleetAdminService,
        BillingService,
        SupportService,
        FleetService,
        DiagnosticsService,
        RemoteSettingsService,
        CloudBackupsService,
        { provide: OBJECT_STORE, useValue: objectStoreFor(config) },
        BackupEscrowService,
        { provide: ESCROW_KEY, useValue: escrowKeySourceFor(config) },
        { provide: ALERT_NOTIFIER, useValue: alertNotifierFor(config) },
        { provide: RELAY_PROVISIONER, useClass: PgRelayProvisioner },
        ReleasesService,
        AdminService,
        MenuExtractionsService,
        { provide: MENU_EXTRACTOR, useValue: menuExtractorFor(config) },
        { provide: APP_GUARD, useClass: InstallationGuard },
        { provide: APP_GUARD, useClass: VendorGuard },
        { provide: CP_ERROR_REPORTER, useValue: errorReporterFor(config) },
        { provide: APP_FILTER, useClass: CpExceptionFilter },
      ],
    };
  }
}
