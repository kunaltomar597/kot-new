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
}

/**
 * Recognises the device behind a request from its device credential. Staff tokens are only
 * accepted together with the device they were issued to (AUTH-005, AUTH-007).
 */
export interface DeviceAuthenticator {
  /** The paired device, or undefined when the request carries no valid device credential. */
  authenticate(request: Request): Promise<AuthenticatedDevice | undefined>;
}

/**
 * Default until device pairing (P0-11) provides the real authenticator: no device is recognised,
 * so nobody can sign in. Deny by default (SEC-003).
 */
export class NoDeviceAuthenticator implements DeviceAuthenticator {
  authenticate(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}
