import type { DeviceType } from '../generated/prisma/enums.js';
import type { Request } from 'express';

/** Injection token for the `DeviceAuthenticator`. */
export const DEVICE_AUTHENTICATOR = Symbol('DEVICE_AUTHENTICATOR');

/** A paired device, as proven by its device credential (AUTH-007). */
export interface AuthenticatedDevice {
  readonly deviceId: string;
  readonly restaurantId: string;
  readonly type: DeviceType;
  /** The table a table tablet is bound to (AUTH-009). */
  readonly tableId: string | null;
  /** The station a kitchen screen shows (KDS-002). */
  readonly stationId: string | null;
  /** The person a pager belongs to. */
  readonly staffId: string | null;
}

/**
 * Recognises the device behind a request from its device credential. Staff tokens are only
 * accepted together with the device they were issued to (AUTH-005, AUTH-007).
 */
export interface DeviceAuthenticator {
  /** The paired device, or undefined when the request carries no valid device credential. */
  authenticate(request: Request): Promise<AuthenticatedDevice | undefined>;
}
