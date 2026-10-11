import type { Capability, Role } from '@rp/domain';
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
  /**
   * What the person's custom role adds to `role` (AUTH-012), already limited to what may be added;
   * empty for a built-in role. Use `@rp/domain` `actorGrant` with it, never `grantFor` alone.
   */
  readonly capabilities: readonly Capability[];
}

/**
 * A kitchen screen acting for its station with nobody signed in (station mode, AUTH-005): it has
 * the kitchen's grants, its actions are attributed to the device, and a screen bound to a station
 * may only act on that station's items.
 */
export interface StationActor {
  readonly restaurantId: string;
  readonly deviceId: string;
  /** The station the screen shows; null shows every station. */
  readonly stationId: string | null;
  /** Every station the screen shows; empty for all of them (KDS-002). */
  readonly stationIds: readonly string[];
}

/** Whoever performs a kitchen or floor step: a signed-in person or a kitchen screen. */
export interface Actor {
  readonly restaurantId: string;
  readonly deviceId: string;
  /** Null in station mode. */
  readonly staffId: string | null;
  readonly role: Role;
  /** A person's custom-role capabilities (AUTH-012); none in station mode. */
  readonly capabilities?: readonly Capability[];
  /** Set in station mode when the screen is bound to one station. */
  readonly stationId?: string | null;
  /** In station mode, every station the screen shows; empty or absent for all (KDS-002). */
  readonly stationIds?: readonly string[];
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
  /** Set by the permission guard for a kitchen screen in station mode. */
  station?: StationActor;
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

/** The person or kitchen screen behind a request to a route that allows station mode. */
export function actorOf(request: AuthenticatedRequest): Actor | undefined {
  if (request.principal !== undefined) return request.principal;
  if (request.station !== undefined) {
    return { ...request.station, staffId: null, role: 'KITCHEN' };
  }
  return undefined;
}
