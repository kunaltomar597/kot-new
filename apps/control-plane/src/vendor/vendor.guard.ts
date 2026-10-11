import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { STEP_UP_HEADER, type VendorCapability } from '@rp/contracts/control-plane';
import type { Request } from 'express';
import { CpError } from '../errors/cp-error.js';
import { type VendorPrincipal, VendorAuthService } from './vendor-auth.service.js';

export const VENDOR_ROUTE = 'cp:vendor';

/**
 * Marks an endpoint for signed-in vendor staff (VCP-001): `capability` is what their role must
 * allow (`@rp/contracts/control-plane` `vendorMay`); none means any signed-in person. The
 * installation guard leaves these endpoints to the vendor guard.
 */
export const Vendor = (capability?: VendorCapability) =>
  SetMetadata(VENDOR_ROUTE, capability ?? 'SESSION');

export const VENDOR_STEP_UP = 'cp:vendor-step-up';

/**
 * The endpoint asks for the authenticator again (CP-S2): a code in `x-rp-step-up` that was not
 * used before, even by the sign-in. Contracts list these operations in `STEP_UP_OPERATIONS`.
 */
export const StepUp = () => SetMetadata(VENDOR_STEP_UP, true);

export type VendorRequest = Request & { vendor?: VendorPrincipal };

export function vendorOf(request: VendorRequest): VendorPrincipal {
  if (request.vendor === undefined) {
    throw new CpError(401, 'VENDOR_UNAUTHENTICATED', 'Sign in again.');
  }
  return request.vendor;
}

/**
 * Checks every `@Vendor()` endpoint: a bearer token of a live session (MFA was part of signing
 * in), and a role that allows the capability (deny by default, SEC-003).
 */
@Injectable()
export class VendorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: VendorAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<VendorCapability | 'SESSION' | undefined>(
      VENDOR_ROUTE,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) return true;
    const request = context.switchToHttp().getRequest<VendorRequest>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header)?.[1] : undefined;
    if (token === undefined) throw new CpError(401, 'VENDOR_UNAUTHENTICATED', 'Sign in first.');
    const principal = await this.auth.authenticate(token);
    if (required !== 'SESSION' && !VendorAuthService.allows(principal, required)) {
      throw new CpError(403, 'FORBIDDEN', 'Your role does not allow this.');
    }
    const stepUp = this.reflector.getAllAndOverride<boolean | undefined>(VENDOR_STEP_UP, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (stepUp === true) {
      const code = request.headers[STEP_UP_HEADER];
      await this.auth.stepUp(principal, typeof code === 'string' ? code : undefined);
    }
    request.vendor = principal;
    return true;
  }
}
