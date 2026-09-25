import type { Role } from '@rp/domain';
import type { Request } from 'express';

/**
 * The authenticated staff member and device behind a request. The authentication middleware
 * (P0-10) sets it on the request after checking the access token; until then no request has one,
 * so every protected route answers 401.
 */
export interface Principal {
  readonly staffId: string;
  readonly role: Role;
  readonly restaurantId: string;
  readonly deviceId: string;
}

export type RequestWithPrincipal = Request & {
  principal?: Principal;
  /** Set by the permission guard when the grant is OWN: the service must check ownership. */
  ownershipRequired?: boolean;
};

export function principalOf(request: Request): Principal | undefined {
  return (request as RequestWithPrincipal).principal;
}
