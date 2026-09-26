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
import { HealthController } from './health/health.controller.js';
import { HeartbeatsController } from './heartbeats/heartbeats.controller.js';
import { HeartbeatsService } from './heartbeats/heartbeats.service.js';
import { EnrolmentController } from './installations/enrolment.controller.js';
import { InstallationsService } from './installations/installations.service.js';
import { ReleasesService } from './releases/releases.service.js';
import { UpdatesController } from './releases/updates.controller.js';

/** Never logged: signatures, enrolment codes and proofs (SEC-015). */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-rp-signature"]',
  'code',
  '*.code',
  'proof',
  '*.proof',
];

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
      controllers: [HealthController, EnrolmentController, HeartbeatsController, UpdatesController],
      providers: [
        { provide: CP_CONFIG, useValue: config },
        PrismaService,
        AuditService,
        RateLimiter,
        NonceStore,
        InstallationsService,
        HeartbeatsService,
        ReleasesService,
        AdminService,
        { provide: APP_GUARD, useClass: InstallationGuard },
        { provide: APP_FILTER, useClass: CpExceptionFilter },
      ],
    };
  }
}
