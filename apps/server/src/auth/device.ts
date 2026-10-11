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
  /** The station a kitchen screen shows (KDS-002); its first, when it shows several. */
  readonly stationId: string | null;
  /** Every station a kitchen screen shows; empty for all of them (KDS-002). */
  readonly stationIds: readonly string[];
  /** The person a pager belongs to, or a waiter phone alerts (P2-06a). */
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

/** The device each request proved, once checked before its body was read (PC-D1). */
const checkedDevices = new WeakMap<Request, { readonly device: AuthenticatedDevice | undefined }>();

/** Keeps what the device check found for this request, a paired device or none. */
export function rememberDevice(request: Request, device: AuthenticatedDevice | undefined): void {
  checkedDevices.set(request, { device });
}

/** What the device check found for this request, or undefined when it has not run yet. */
export function rememberedDevice(
  request: Request,
): { readonly device: AuthenticatedDevice | undefined } | undefined {
  return checkedDevices.get(request);
}
