import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionGuard } from './permission.guard.js';

/**
 * Authorisation for every route (AUTH-010, SEC-003). P0-10 adds authentication (PIN login,
 * tokens, sessions) that sets the request principal the guard checks.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
export class AuthModule {}
