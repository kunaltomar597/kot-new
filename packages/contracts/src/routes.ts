import type { Capability } from '@rp/domain';
import { z } from 'zod';
import { AuditVerifyResponse } from './audit.js';
import {
  CurrentSessionResponse,
  LoginResponse,
  OverrideRequest,
  OverrideResponse,
  OwnerLoginRequest,
  OwnerPasswordRequest,
  PinLoginRequest,
  RefreshRequest,
  StaffTilesResponse,
  StepUpRequest,
  StepUpResponse,
  TotpConfirmRequest,
  TotpConfirmResponse,
  TotpEnrollmentResponse,
  UnlockStaffRequest,
} from './auth.js';
import { ApiError, Id } from './common.js';
import {
  BindTableRequest,
  CreatePairingCodeRequest,
  DeviceChallengeRequest,
  DeviceChallengeResponse,
  DeviceListResponse,
  DeviceSummary,
  DeviceTokenRequest,
  DeviceTokenResponse,
  PairDeviceRequest,
  PairedDevice,
  PairingCodeResponse,
  RevokeDeviceRequest,
} from './devices.js';
import { SubmitOrderRequest, SubmitOrderResponse } from './order.js';
import { HealthResponse, TlsCaResponse, VersionResponse } from './system.js';

/**
 * REST route registry (INT-002). Each entry ties an endpoint to the contract schemas it accepts
 * and returns, so the OpenAPI document (`pnpm contracts:docs`, docs/api/openapi.json) is generated
 * from the same schemas the server validates with. Work packages that add an endpoint add its
 * entry here; every schema a route uses must be exported from this package so it has a stable
 * name in the document.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteResponse {
  description: string;
  /** Omit for responses without a body (e.g. 204). */
  schema?: z.ZodType;
}

export interface RouteDefinition {
  /** Stable, unique camelCase name; becomes the OpenAPI operationId and the api-client method. */
  operationId: string;
  method: HttpMethod;
  /** Full path with Express-style parameters, e.g. `/api/v1/orders/:orderId/approve`. */
  path: string;
  summary: string;
  description?: string;
  tags: readonly string[];
  /** BRD requirement IDs the endpoint implements. */
  requirements: readonly string[];
  /**
   * Capability the server enforces (AUTH-010, deny by default); `SESSION` for endpoints any
   * signed-in person may call (the service checks anything further, e.g. Owner only); `DEVICE` for
   * endpoints that need a paired device but no signed-in person (login screen, token refresh); or
   * `PUBLIC` for the few endpoints that need neither (they must say why in `description`).
   */
  capability: Capability | 'SESSION' | 'DEVICE' | 'PUBLIC';
  request?: {
    params?: z.ZodObject;
    query?: z.ZodObject;
    body?: z.ZodType;
  };
  responses: Readonly<Record<number, RouteResponse>>;
}

/** Error responses shared by every authenticated endpoint. */
const standardErrors = {
  400: { description: 'The request does not match the contract.', schema: ApiError },
  401: { description: 'No valid session or device credential.', schema: ApiError },
  403: { description: 'The signed-in role lacks the required capability.', schema: ApiError },
} as const satisfies Readonly<Record<number, RouteResponse>>;

/** Error responses of endpoints that need a paired device but no signed-in person. */
const deviceErrors = {
  400: standardErrors[400],
  401: { description: 'Unknown or unpaired device, or invalid credentials.', schema: ApiError },
} as const satisfies Readonly<Record<number, RouteResponse>>;

export const ROUTES = [
  {
    operationId: 'submitOrder',
    method: 'POST',
    path: '/api/v1/orders',
    summary: 'Submit an order from any ordering surface',
    description:
      'Prices, taxes and availability are recomputed by the server; the request carries no prices ' +
      '(ORD-014). Resubmitting with the same idempotency key returns the original result with ' +
      '`replayed: true` and never creates a second order or KOT (ORD-013).',
    tags: ['orders'],
    requirements: ['ORD-001', 'ORD-013', 'ORD-014', 'ORD-017'],
    capability: 'ORDER_CREATE',
    request: { body: SubmitOrderRequest },
    responses: {
      200: { description: 'Order accepted or lines rejected.', schema: SubmitOrderResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getHealth',
    method: 'GET',
    path: '/api/v1/health',
    summary: 'Server liveness and database status',
    description:
      'Public because the watchdog and the support screen call it without a session; it reveals ' +
      'no business data. Returns 503 when the database is down so the watchdog restarts the ' +
      'server (NFR-A04).',
    tags: ['system'],
    requirements: ['NFR-A04', 'NFR-O01'],
    capability: 'PUBLIC',
    responses: {
      200: { description: 'Server and database are up.', schema: HealthResponse },
      503: { description: 'The database is down.', schema: HealthResponse },
    },
  },
  {
    operationId: 'getVersion',
    method: 'GET',
    path: '/api/v1/version',
    summary: 'Server component version',
    description:
      'Public because devices check compatibility (UPD-006) before signing in; it reveals only ' +
      'version numbers.',
    tags: ['system'],
    requirements: ['UPD-006'],
    capability: 'PUBLIC',
    responses: {
      200: { description: 'Component and API version.', schema: VersionResponse },
    },
  },
  {
    operationId: 'getTlsCa',
    method: 'GET',
    path: '/api/v1/tls/ca',
    summary: 'The LAN certificate authority to pin or install',
    description:
      'Public because a device needs it before it can pair: apps pin the CA and browsers install ' +
      'it (ADR-0011). It is a public certificate; people compare its fingerprint with the one the ' +
      'POS shows. 404 when the server runs without TLS (development).',
    tags: ['system'],
    requirements: ['SEC-001', 'SEC-010'],
    capability: 'PUBLIC',
    responses: {
      200: { description: 'The CA certificate.', schema: TlsCaResponse },
      404: { description: 'This server does not use TLS.', schema: ApiError },
    },
  },
  {
    operationId: 'verifyAuditChain',
    method: 'GET',
    path: '/api/v1/audit/verify',
    summary: 'Recompute the audit hash chain and report the first broken link',
    description:
      'Walks the whole audit log in order, recomputing every hash (AUD-003). A valid chain returns ' +
      'its head, which heartbeats also send to the Control Plane. Owner and Manager only.',
    tags: ['audit'],
    requirements: ['AUD-003', 'AUD-004'],
    capability: 'AUDIT_VIEW',
    responses: {
      200: { description: 'Verification result.', schema: AuditVerifyResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'listStaffTiles',
    method: 'GET',
    path: '/api/v1/auth/staff-tiles',
    summary: 'Names and photos for the login screen of this device',
    description: 'Active staff who can sign in with a PIN; never includes PIN hints (AUTH-001).',
    tags: ['auth'],
    requirements: ['AUTH-001'],
    capability: 'DEVICE',
    responses: {
      200: { description: 'Login tiles.', schema: StaffTilesResponse },
      ...deviceErrors,
    },
  },
  {
    operationId: 'pinLogin',
    method: 'POST',
    path: '/api/v1/auth/pin-login',
    summary: 'Sign in on this device with a staff PIN',
    description:
      'Locks the staff login for 15 min after 5 failures in 10 min and rate-limits attempts per ' +
      'device (AUTH-003, SEC-009). Kitchen staff sign in only when individual kitchen logins are on.',
    tags: ['auth'],
    requirements: ['AUTH-001', 'AUTH-002', 'AUTH-003', 'AUTH-005', 'AUTH-013'],
    capability: 'DEVICE',
    request: { body: PinLoginRequest },
    responses: {
      200: { description: 'Signed in.', schema: LoginResponse },
      ...deviceErrors,
      423: { description: 'Login locked after repeated failures.', schema: ApiError },
      429: { description: 'Too many attempts from this device.', schema: ApiError },
    },
  },
  {
    operationId: 'ownerLogin',
    method: 'POST',
    path: '/api/v1/auth/owner-login',
    summary: 'Sign in as the Owner with password and second factor',
    description:
      'Password + TOTP (or a recovery code) sign-in; the session carries a fresh step-up for ' +
      'Owner-only actions (AUTH-006).',
    tags: ['auth'],
    requirements: ['AUTH-006', 'AUTH-013'],
    capability: 'DEVICE',
    request: { body: OwnerLoginRequest },
    responses: {
      200: { description: 'Signed in.', schema: LoginResponse },
      ...deviceErrors,
      423: { description: 'Login locked after repeated failures.', schema: ApiError },
      429: { description: 'Too many attempts from this device.', schema: ApiError },
    },
  },
  {
    operationId: 'refreshSession',
    method: 'POST',
    path: '/api/v1/auth/refresh',
    summary: 'Get a new access token and rotate the refresh token',
    description:
      'Fails when the session was revoked, expired or idle too long. Reusing an old refresh token ' +
      'revokes the whole session (AUTH-005).',
    tags: ['auth'],
    requirements: ['AUTH-005'],
    capability: 'DEVICE',
    request: { body: RefreshRequest },
    responses: { 200: { description: 'New tokens.', schema: LoginResponse }, ...deviceErrors },
  },
  {
    operationId: 'logout',
    method: 'POST',
    path: '/api/v1/auth/logout',
    summary: 'End the current session',
    tags: ['auth'],
    requirements: ['AUTH-005', 'AUTH-013'],
    capability: 'SESSION',
    responses: { 204: { description: 'Signed out.' }, ...standardErrors },
  },
  {
    operationId: 'getCurrentSession',
    method: 'GET',
    path: '/api/v1/auth/session',
    summary: 'The signed-in person and their session on this device',
    description:
      'Apps check a restored session with it after a restart. Like every authenticated call it ' +
      'counts as activity, so an app can keep a session alive while the person is using it.',
    tags: ['auth'],
    requirements: ['AUTH-005'],
    capability: 'SESSION',
    responses: {
      200: { description: 'The current session.', schema: CurrentSessionResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'stepUp',
    method: 'POST',
    path: '/api/v1/auth/step-up',
    summary: 'Confirm the Owner password and second factor for Owner-only actions',
    tags: ['auth'],
    requirements: ['AUTH-006'],
    capability: 'SESSION',
    request: { body: StepUpRequest },
    responses: { 200: { description: 'Step-up done.', schema: StepUpResponse }, ...standardErrors },
  },
  {
    operationId: 'grantOverride',
    method: 'POST',
    path: '/api/v1/auth/override',
    summary: 'A manager approves one action on this device with their PIN',
    description:
      'Returns a single-use token for one capability (and entity) of the signed-in requester; ' +
      'both people are audited (AUTH-011).',
    tags: ['auth'],
    requirements: ['AUTH-011', 'AUTH-013'],
    capability: 'SESSION',
    request: { body: OverrideRequest },
    responses: {
      200: { description: 'Override granted.', schema: OverrideResponse },
      ...standardErrors,
      423: { description: "The manager's login is locked.", schema: ApiError },
      429: { description: 'Too many attempts from this device.', schema: ApiError },
    },
  },
  {
    operationId: 'unlockStaff',
    method: 'POST',
    path: '/api/v1/auth/unlock',
    summary: "Unlock a staff member's PIN login after repeated failures",
    tags: ['auth'],
    requirements: ['AUTH-003', 'AUTH-013'],
    capability: 'STAFF_MANAGE',
    request: { body: UnlockStaffRequest },
    responses: { 204: { description: 'Unlocked.' }, ...standardErrors },
  },
  {
    operationId: 'enrollOwnerTotp',
    method: 'POST',
    path: '/api/v1/auth/owner/totp/enroll',
    summary: 'Start (or restart) TOTP enrolment for the Owner',
    description: 'Replacing a confirmed TOTP needs a fresh step-up (AUTH-006).',
    tags: ['auth'],
    requirements: ['AUTH-006'],
    capability: 'SESSION',
    responses: {
      200: { description: 'New secret to add to the app.', schema: TotpEnrollmentResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'confirmOwnerTotp',
    method: 'POST',
    path: '/api/v1/auth/owner/totp/confirm',
    summary: 'Confirm TOTP enrolment with a code and receive recovery codes',
    tags: ['auth'],
    requirements: ['AUTH-006'],
    capability: 'SESSION',
    request: { body: TotpConfirmRequest },
    responses: {
      200: { description: 'Enrolled; recovery codes shown once.', schema: TotpConfirmResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'setOwnerPassword',
    method: 'POST',
    path: '/api/v1/auth/owner/password',
    summary: 'Set or change the Owner password',
    description: 'Changing an existing password needs the current one and a fresh step-up.',
    tags: ['auth'],
    requirements: ['AUTH-006'],
    capability: 'SESSION',
    request: { body: OwnerPasswordRequest },
    responses: { 204: { description: 'Password saved.' }, ...standardErrors },
  },
  {
    operationId: 'createPairingCode',
    method: 'POST',
    path: '/api/v1/devices/pairing-codes',
    summary: 'Prepare the pairing of a device: a one-time code and QR payload',
    description:
      'The code is valid for 10 minutes (setting) and pairs exactly one device (AUTH-007).',
    tags: ['devices'],
    requirements: ['AUTH-007', 'AUTH-009'],
    capability: 'DEVICE_PAIR',
    request: { body: CreatePairingCodeRequest },
    responses: {
      201: { description: 'Pairing code.', schema: PairingCodeResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createBootstrapPairingCode',
    method: 'POST',
    path: '/api/v1/devices/pairing-codes/bootstrap',
    summary: 'Pairing code for the first device, from the server PC itself',
    description:
      'Public because no device exists yet to sign in on. Only answers requests from the server ' +
      "PC's loopback address, and only while the restaurant has no paired device; the installer " +
      'uses it to pair the POS on the server PC (ONB-001).',
    tags: ['devices'],
    requirements: ['AUTH-007', 'ONB-001'],
    capability: 'PUBLIC',
    responses: {
      201: { description: 'Pairing code for a POS.', schema: PairingCodeResponse },
      403: {
        description: 'Not from the server PC, or a device is already paired.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'pairDevice',
    method: 'POST',
    path: '/api/v1/devices/pair',
    summary: 'A device pairs with a one-time code and its public key',
    description:
      'Public because the device has no credential yet: the one-time code is the credential. ' +
      'The device proves it holds the private key by signing the code. Rate-limited (SEC-009).',
    tags: ['devices'],
    requirements: ['AUTH-007', 'SEC-006', 'SEC-009'],
    capability: 'PUBLIC',
    request: { body: PairDeviceRequest },
    responses: {
      201: { description: 'Paired.', schema: PairedDevice },
      400: standardErrors[400],
      401: { description: 'Unknown, used or expired code, or a bad proof.', schema: ApiError },
      429: { description: 'Too many attempts.', schema: ApiError },
    },
  },
  {
    operationId: 'createDeviceChallenge',
    method: 'POST',
    path: '/api/v1/devices/challenge',
    summary: 'A one-time challenge for a paired device to sign',
    description:
      'Public because it is the first step of device authentication; a challenge alone grants ' +
      'nothing (AUTH-007).',
    tags: ['devices'],
    requirements: ['AUTH-007'],
    capability: 'PUBLIC',
    request: { body: DeviceChallengeRequest },
    responses: {
      200: { description: 'Challenge valid for 60 seconds.', schema: DeviceChallengeResponse },
      400: standardErrors[400],
      429: { description: 'Too many attempts.', schema: ApiError },
    },
  },
  {
    operationId: 'issueDeviceToken',
    method: 'POST',
    path: '/api/v1/devices/token',
    summary: 'Exchange a signed challenge for a device token',
    description:
      'Public because it is how a device authenticates: the signature over the challenge with ' +
      'the paired key is the credential (AUTH-007).',
    tags: ['devices'],
    requirements: ['AUTH-007', 'SEC-006'],
    capability: 'PUBLIC',
    request: { body: DeviceTokenRequest },
    responses: {
      200: { description: 'Device token.', schema: DeviceTokenResponse },
      400: standardErrors[400],
      401: { description: 'Unknown or revoked device, or a bad signature.', schema: ApiError },
      429: { description: 'Too many attempts.', schema: ApiError },
    },
  },
  {
    operationId: 'getCurrentDevice',
    method: 'GET',
    path: '/api/v1/devices/current',
    summary: 'This device: its type, name and binding',
    description:
      'Apps read their own type and binding (table, station, person) after a restart or when a ' +
      'manager has changed them.',
    tags: ['devices'],
    requirements: ['AUTH-007', 'AUTH-009'],
    capability: 'DEVICE',
    responses: { 200: { description: 'This device.', schema: DeviceSummary }, ...deviceErrors },
  },
  {
    operationId: 'listDevices',
    method: 'GET',
    path: '/api/v1/devices',
    summary: 'Paired and revoked devices of the restaurant',
    tags: ['devices'],
    requirements: ['AUTH-007', 'AUTH-008'],
    capability: 'DEVICE_PAIR',
    responses: { 200: { description: 'Devices.', schema: DeviceListResponse }, ...standardErrors },
  },
  {
    operationId: 'revokeDevice',
    method: 'POST',
    path: '/api/v1/devices/:deviceId/revoke',
    summary: 'Unpair a device: its tokens and sessions stop working at once',
    tags: ['devices'],
    requirements: ['AUTH-008'],
    capability: 'DEVICE_PAIR',
    request: { params: z.object({ deviceId: Id }), body: RevokeDeviceRequest },
    responses: { 200: { description: 'Revoked.', schema: DeviceSummary }, ...standardErrors },
  },
  {
    operationId: 'bindTabletTable',
    method: 'PUT',
    path: '/api/v1/devices/:deviceId/table',
    summary: 'Move a table tablet to another table',
    description: 'Needs a manager (AUTH-009); the tablet then serves only the new table.',
    tags: ['devices'],
    requirements: ['AUTH-009'],
    capability: 'DEVICE_PAIR',
    request: { params: z.object({ deviceId: Id }), body: BindTableRequest },
    responses: { 200: { description: 'Rebound.', schema: DeviceSummary }, ...standardErrors },
  },
] as const satisfies readonly RouteDefinition[];
