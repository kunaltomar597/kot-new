import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OVERRIDE_TOKEN_HEADER } from '@rp/contracts';
import {
  actorGrant,
  grantFor,
  OVERRIDE_RECORD_TYPES,
  OWNER_SECOND_FACTOR_CAPABILITIES,
} from '@rp/domain';
import { authErrors } from './auth-errors.js';
import { AuthSettingsService } from './auth-settings.js';
import { AuthService } from './auth.service.js';
import { ROUTE_ACCESS, type RouteAccess } from './decorators.js';
import type { AuthenticatedRequest, Principal } from './principal.js';

/**
 * Global guard: deny by default (AUTH-010, SEC-003). Every route declares its access:
 *
 * - `@Public()` passes.
 * - `@RequireDevice(devices)` needs a paired device of one of those kinds.
 * - `@RequireSession()` needs a signed-in person (on the device their token was issued to, one
 *   of the devices staff sign in on: `STAFF_DEVICE_TYPES`);
 *   `{ stationMode: true }` also admits a kitchen screen in station mode (see below).
 * - `@RequireCapability(c, { stationMode: true })` also lets a kitchen screen with nobody signed in
 *   act for the kitchen (station mode, AUTH-005), when kitchen staff do not sign in individually
 *   and the kitchen role is granted `c`; the guard sets `request.station`.
 * - `@RequireCapability(c)` needs a signed-in person whose role is granted `c` in the BRD §4.2
 *   matrix. ALLOW passes, and Owner-only capabilities (AUTH-006) also need a fresh password + TOTP
 *   step-up. OWN passes with `request.ownershipRequired` set, so the service checks the table or
 *   shift belongs to the person. OVERRIDE needs a manager's single-use override token in the
 *   `x-override-token` header (AUTH-011), given for the record in the route's `record` parameter
 *   (PC-T2). DENY is refused.
 * - Routes that declare nothing are refused and logged: a missing declaration is a bug.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly settings: AuthSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    switch (access?.kind) {
      case 'PUBLIC':
        return true;
      case 'DEVICE':
        if (request.device === undefined) throw authErrors.deviceNotRecognised();
        if (!access.devices.includes(request.device.type)) throw authErrors.deviceNotAllowed();
        return true;
      case 'SESSION':
        if (access.stationMode === true && (await this.stationMode(request))) return true;
        this.principal(request);
        return true;
      case 'CAPABILITY':
        if (access.stationMode === true && (await this.stationMode(request, access.capability))) {
          return true;
        }
        return this.checkCapability(request, access);
      case undefined:
        this.logger.error(
          { path: request.originalUrl },
          'Route declares no access decorator; refusing the request',
        );
        throw authErrors.forbidden();
    }
  }

  /**
   * Whether a kitchen screen with nobody signed in may act for its station here: with a
   * capability, the kitchen role must be granted it; without one, the service checks the step.
   */
  private async stationMode(
    request: AuthenticatedRequest,
    capability?: Extract<RouteAccess, { kind: 'CAPABILITY' }>['capability'],
  ): Promise<boolean> {
    const device = request.device;
    if (request.principal !== undefined || request.authFailure !== undefined) return false;
    if (device?.type !== 'KDS') return false;
    const settings = await this.settings.get(device.restaurantId);
    if (settings.kitchenIndividualLogins) return false;
    if (capability !== undefined && grantFor('KITCHEN', capability) !== 'ALLOW') return false;
    request.station = {
      restaurantId: device.restaurantId,
      deviceId: device.deviceId,
      stationId: device.stationId,
      stationIds: device.stationIds,
    };
    return true;
  }

  private principal(request: AuthenticatedRequest): Principal {
    if (request.principal !== undefined) return request.principal;
    if (request.authFailure !== undefined) throw request.authFailure;
    if (request.device === undefined) throw authErrors.deviceNotRecognised();
    throw authErrors.unauthenticated();
  }

  private async checkCapability(
    request: AuthenticatedRequest,
    access: Extract<RouteAccess, { kind: 'CAPABILITY' }>,
  ): Promise<boolean> {
    const { capability } = access;
    const principal = this.principal(request);
    // A custom role's extra capabilities count as ALLOW (AUTH-012).
    switch (
      actorGrant({ role: principal.role, extraCapabilities: principal.capabilities }, capability)
    ) {
      case 'ALLOW':
        if (OWNER_SECOND_FACTOR_CAPABILITIES.has(capability)) {
          const settings = await this.settings.get(principal.restaurantId);
          if (!this.auth.hasFreshStepUp(principal, settings)) {
            throw authErrors.secondFactorRequired();
          }
        }
        return true;
      case 'OWN':
        request.ownershipRequired = true;
        return true;
      case 'OVERRIDE': {
        const header = request.headers[OVERRIDE_TOKEN_HEADER];
        const token = Array.isArray(header) ? header[0] : header;
        if (token === undefined || token === '') throw authErrors.overrideRequired(capability);
        const override = await this.auth.consumeOverride(
          principal,
          capability,
          token,
          this.overrideRecord(request, access),
        );
        if (override === null) throw authErrors.overrideInvalid();
        request.override = override;
        return true;
      }
      case 'DENY':
        throw authErrors.forbidden();
    }
  }

  /**
   * The record a route acts on, for an approval that must be for it (PC-T2). A route of such a
   * capability that does not say where its record is would let any approval through: refused.
   */
  private overrideRecord(
    request: AuthenticatedRequest,
    access: Extract<RouteAccess, { kind: 'CAPABILITY' }>,
  ): { readonly entityType: string; readonly entityId: string } | undefined {
    const entityType = OVERRIDE_RECORD_TYPES[access.capability];
    if (entityType === undefined) return undefined;
    const entityId = access.record === undefined ? undefined : request.params[access.record];
    if (typeof entityId !== 'string' || entityId === '') {
      this.logger.error(
        { path: request.originalUrl, capability: access.capability },
        'Route does not say which record its approval is for; refusing the request',
      );
      throw authErrors.forbidden();
    }
    return { entityType, entityId };
  }
}
