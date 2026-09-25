import type { Capability } from '@rp/domain';
import type { z } from 'zod';
import { AuditVerifyResponse } from './audit.js';
import {
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
import { ApiError } from './common.js';
import { SubmitOrderRequest, SubmitOrderResponse } from './order.js';
import { HealthResponse, VersionResponse } from './system.js';

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
] as const satisfies readonly RouteDefinition[];
