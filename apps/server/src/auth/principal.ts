import type { Role } from '@rp/domain';
import type { Request } from 'express';
import type { AppError } from '../errors/app-error.js';
import type { AuthenticatedDevice } from './device.js';

/** The signed-in staff member behind a request, on the device that proved itself (AUTH-005). */
export interface Principal {
  readonly staffId: string;
  readonly role: Role;
  readonly restaurantId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  /** When the Owner last confirmed password + second factor in this session (AUTH-006). */
  readonly secondFactorAt: Date | null;
}

/** A manager's approval consumed for this request (AUTH-011). */
export interface ConsumedOverride {
  readonly approverId: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
}

export type AuthenticatedRequest = Request & {
  device?: AuthenticatedDevice;
  principal?: Principal;
  /** Why a presented access token was not accepted; returned by protected routes. */
  authFailure?: AppError;
  /** Set by the permission guard when the grant is OWN: the service must check ownership. */
  ownershipRequired?: boolean;
  override?: ConsumedOverride;
};

export function principalOf(request: Request): Principal | undefined {
  return (request as AuthenticatedRequest).principal;
}

export function deviceOf(request: Request): AuthenticatedDevice | undefined {
  return (request as AuthenticatedRequest).device;
}
