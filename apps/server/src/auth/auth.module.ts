import { join } from 'node:path';
import { Logger, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthSettingsService } from './auth-settings.js';
import { AuthenticationMiddleware } from './authentication.middleware.js';
import { CredentialHasher } from './credential-hasher.js';
import { DEVICE_AUTHENTICATOR, NoDeviceAuthenticator } from './device.js';
import { PermissionGuard } from './permission.guard.js';
import { RateLimiter } from './rate-limiter.js';
import { FileSecretStore, SECRET_STORE } from './secret-store.js';
import { SessionService } from './session.service.js';
import { TokenService } from './tokens.js';

/**
 * Authentication and authorisation for every route (AUTH-001 to AUTH-006, AUTH-010, AUTH-011,
 * SEC-003). The device authenticator is replaced by device pairing (P0-11); the secret store by
 * the Windows DPAPI store in the installer (P0-16).
 */
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: SECRET_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.nodeEnv === 'production') {
          new Logger('SecretStore').warn(
            'Using file secrets; the installed server must use the Windows DPAPI store (SEC-006).',
          );
        }
        return new FileSecretStore(join(config.dataDir, 'secrets'));
      },
    },
    { provide: DEVICE_AUTHENTICATOR, useClass: NoDeviceAuthenticator },
    AuthSettingsService,
    CredentialHasher,
    TokenService,
    RateLimiter,
    SessionService,
    AuthService,
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthService, SessionService, CredentialHasher, AuthSettingsService, SECRET_STORE],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthenticationMiddleware).forRoutes('*path');
  }
}
