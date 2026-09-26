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
import {
  FloorArchiveRequest,
  FloorResponse,
  SectionParams,
  SectionRequest,
  SectionView,
  TableParams,
  TableRequest,
  TableView,
  UpdateWaiterAssignmentsRequest,
  WaiterAssignmentsResponse,
} from './floor.js';
import {
  CategoryRequest,
  CategoryView,
  ComboRequest,
  ComboView,
  ItemAvailabilityRequest,
  ItemAvailabilityView,
  ItemRequest,
  ItemView,
  MenuArchiveRequest,
  MenuDraftResponse,
  MenuEntityParams,
  MenuPublishResponse,
  ModifierGroupRequest,
  ModifierGroupView,
} from './menu-admin.js';
import { MenuSnapshot } from './menu.js';
import { SubmitOrderRequest, SubmitOrderResponse } from './order.js';
import {
  AssignSessionWaiterRequest,
  CloseWithoutBillRequest,
  MoveTableRequest,
  OpenTableRequest,
  TableOverviewResponse,
  TableSessionParams,
  TableSessionView,
} from './table-sessions.js';
import {
  ArchiveRequest,
  InvoiceSeriesListResponse,
  InvoiceSeriesParams,
  InvoiceSeriesRequest,
  InvoiceSeriesView,
  RestaurantProfile,
  TaxGroupListResponse,
  TaxGroupParams,
  TaxGroupRequest,
  TaxGroupView,
  UpdateRestaurantLegalRequest,
  UpdateRestaurantProfileRequest,
} from './restaurant.js';
import {
  SettingKeyParams,
  SettingsResponse,
  SettingView,
  UpdateSettingRequest,
} from './settings.js';
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

/** Who may call a local server endpoint (see `RouteDefinition.capability`). */
export type RouteCapability = Capability | 'SESSION' | 'DEVICE' | 'PUBLIC';

/**
 * One REST endpoint. `TAccess` is the access vocabulary of the API it belongs to: the local
 * server's (the default) or the Control Plane's (`@rp/contracts/control-plane`).
 */
export interface RouteDefinition<TAccess extends string = RouteCapability> {
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
  capability: TAccess;
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
    operationId: 'listSettings',
    method: 'GET',
    path: '/api/v1/settings',
    summary: 'Every setting with its value, default and whether the caller may change it',
    description:
      'The whole catalogue (P1-01a): values the restaurant changed and the BRD defaults for the ' +
      'rest. Vendor-controlled settings are listed read-only (UPD-010).',
    tags: ['settings'],
    requirements: ['MGR-007', 'UPD-010', 'NFR-L03'],
    capability: 'OPERATIONS_CONFIGURE',
    responses: {
      200: { description: 'The settings.', schema: SettingsResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'updateSetting',
    method: 'PUT',
    path: '/api/v1/settings/:key',
    summary: 'Change one setting',
    description:
      'The value must match the setting (and the rules between settings). Each setting names the ' +
      'capability needed: tax and invoice, data and licence settings need the Owner with a fresh ' +
      'second factor (AUTH-006); vendor-controlled settings cannot be changed here. Audited with ' +
      'before and after, and announced with `SettingsChanged`.',
    tags: ['settings'],
    requirements: ['MGR-007', 'AUD-001', 'AUTH-006', 'BILL-006'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: SettingKeyParams, body: UpdateSettingRequest },
    responses: {
      200: { description: 'The setting as it is now.', schema: SettingView },
      ...standardErrors,
      404: { description: 'No such setting.', schema: ApiError },
      422: { description: 'The value is not allowed.', schema: ApiError },
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
  {
    operationId: 'getRestaurant',
    method: 'GET',
    path: '/api/v1/restaurant',
    summary: 'The restaurant: names, invoice particulars, contact, hours and business-day cut-off',
    description:
      'For any paired device: the login screen shows the name and logo, and bills print the ' +
      'legal particulars (BILL-002).',
    tags: ['restaurant'],
    requirements: ['ONB-004', 'BILL-002', 'NFR-L03'],
    capability: 'DEVICE',
    responses: {
      200: { description: 'The restaurant.', schema: RestaurantProfile },
      ...deviceErrors,
    },
  },
  {
    operationId: 'updateRestaurantProfile',
    method: 'PUT',
    path: '/api/v1/restaurant/profile',
    summary: 'Change the display name, contact, opening hours, logo or business-day cut-off',
    description:
      'Audited with before and after, and announced with `RestaurantChanged`. A new cut-off ' +
      'is refused while it would move the current business date (BRD §9.4): change it during ' +
      'the day, not in the hours around the cut-off.',
    tags: ['restaurant'],
    requirements: ['ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { body: UpdateRestaurantProfileRequest },
    responses: {
      200: { description: 'The restaurant as it is now.', schema: RestaurantProfile },
      ...standardErrors,
      409: { description: 'The cut-off change would move the business date.', schema: ApiError },
      422: { description: 'No such logo photo.', schema: ApiError },
    },
  },
  {
    operationId: 'updateRestaurantLegal',
    method: 'PUT',
    path: '/api/v1/restaurant/legal',
    summary: 'Change the invoice particulars: legal name, address, state, GSTIN and FSSAI number',
    description:
      'Tax and invoice settings: the Owner with a fresh second factor (AUTH-006). The GSTIN must ' +
      'pass its checksum and belong to the restaurant state (BILL-002). Audited.',
    tags: ['restaurant'],
    requirements: ['ONB-004', 'BILL-002', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { body: UpdateRestaurantLegalRequest },
    responses: {
      200: { description: 'The restaurant as it is now.', schema: RestaurantProfile },
      ...standardErrors,
    },
  },
  {
    operationId: 'listTaxGroups',
    method: 'GET',
    path: '/api/v1/tax-groups',
    summary: 'Tax groups with their rates, archived ones included',
    description: 'Menu editing assigns items to tax groups; any signed-in person may read them.',
    tags: ['restaurant'],
    requirements: ['BILL-004', 'ONB-004'],
    capability: 'SESSION',
    responses: {
      200: { description: 'Tax groups.', schema: TaxGroupListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createTaxGroup',
    method: 'POST',
    path: '/api/v1/tax-groups',
    summary: 'Add a tax group, e.g. "GST 5 %" = CGST 2.5 % + SGST 2.5 %',
    description:
      'Rates are entered by the restaurant, never built in (BILL-004). The Owner with a fresh ' +
      'second factor (AUTH-006). Audited.',
    tags: ['restaurant'],
    requirements: ['BILL-004', 'ONB-004', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { body: TaxGroupRequest },
    responses: {
      201: { description: 'The new tax group.', schema: TaxGroupView },
      ...standardErrors,
      409: { description: 'Another tax group has that name.', schema: ApiError },
    },
  },
  {
    operationId: 'updateTaxGroup',
    method: 'PUT',
    path: '/api/v1/tax-groups/:taxGroupId',
    summary: 'Change a tax group: name, SAC code or rates',
    description:
      'New rates apply to bills issued from now on; issued invoices keep their own tax lines. ' +
      'The Owner with a fresh second factor (AUTH-006). Audited with before and after.',
    tags: ['restaurant'],
    requirements: ['BILL-004', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { params: TaxGroupParams, body: TaxGroupRequest },
    responses: {
      200: { description: 'The tax group as it is now.', schema: TaxGroupView },
      ...standardErrors,
      404: { description: 'No such tax group.', schema: ApiError },
      409: { description: 'Archived, or another tax group has that name.', schema: ApiError },
    },
  },
  {
    operationId: 'archiveTaxGroup',
    method: 'POST',
    path: '/api/v1/tax-groups/:taxGroupId/archive',
    summary: 'Archive a tax group no menu item uses',
    description: 'Master data is archived, never deleted (BRD §9.4). Owner with second factor.',
    tags: ['restaurant'],
    requirements: ['BILL-004', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { params: TaxGroupParams, body: ArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: TaxGroupView },
      ...standardErrors,
      404: { description: 'No such tax group.', schema: ApiError },
      409: { description: 'Menu items still use it.', schema: ApiError },
    },
  },
  {
    operationId: 'listInvoiceSeries',
    method: 'GET',
    path: '/api/v1/invoice-series',
    summary: 'Invoice series with an example number, archived ones included',
    tags: ['restaurant'],
    requirements: ['BILL-003', 'ONB-004'],
    capability: 'SESSION',
    responses: {
      200: { description: 'Invoice series.', schema: InvoiceSeriesListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createInvoiceSeries',
    method: 'POST',
    path: '/api/v1/invoice-series',
    summary: 'Add an invoice series',
    description:
      'Numbers are at most 16 characters (BILL-003). The first series becomes the default. The ' +
      'Owner with a fresh second factor (AUTH-006). Audited.',
    tags: ['restaurant'],
    requirements: ['BILL-003', 'ONB-004', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { body: InvoiceSeriesRequest },
    responses: {
      201: { description: 'The new series.', schema: InvoiceSeriesView },
      ...standardErrors,
      409: { description: 'Another series has that prefix.', schema: ApiError },
    },
  },
  {
    operationId: 'updateInvoiceSeries',
    method: 'PUT',
    path: '/api/v1/invoice-series/:seriesId',
    summary: 'Rename a series, or change its format while it has no invoices',
    description:
      'Once an invoice is issued the prefix and format are fixed, so numbers stay consecutive ' +
      '(BILL-003). The Owner with a fresh second factor (AUTH-006). Audited.',
    tags: ['restaurant'],
    requirements: ['BILL-003', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { params: InvoiceSeriesParams, body: InvoiceSeriesRequest },
    responses: {
      200: { description: 'The series as it is now.', schema: InvoiceSeriesView },
      ...standardErrors,
      404: { description: 'No such series.', schema: ApiError },
      409: {
        description: 'Archived, the format is fixed, or the prefix is taken.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'archiveInvoiceSeries',
    method: 'POST',
    path: '/api/v1/invoice-series/:seriesId/archive',
    summary: 'Stop using a series; its invoices keep their numbers',
    description: 'The default series cannot be archived: make another the default first.',
    tags: ['restaurant'],
    requirements: ['BILL-003', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { params: InvoiceSeriesParams, body: ArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: InvoiceSeriesView },
      ...standardErrors,
      404: { description: 'No such series.', schema: ApiError },
      409: { description: 'It is the default series.', schema: ApiError },
    },
  },
  {
    operationId: 'setDefaultInvoiceSeries',
    method: 'POST',
    path: '/api/v1/invoice-series/:seriesId/default',
    summary: 'Make a series the one new bills use',
    tags: ['restaurant'],
    requirements: ['BILL-003', 'AUTH-006', 'AUD-001'],
    capability: 'TAX_AND_INVOICE_SETTINGS',
    request: { params: InvoiceSeriesParams },
    responses: {
      200: { description: 'The new default series.', schema: InvoiceSeriesView },
      ...standardErrors,
      404: { description: 'No such series.', schema: ApiError },
      409: { description: 'The series is archived.', schema: ApiError },
    },
  },
  {
    operationId: 'getFloor',
    method: 'GET',
    path: '/api/v1/floor',
    summary: 'Sections and their tables with state and paired tablets, archived ones included',
    tags: ['floor'],
    requirements: ['TBL-001', 'TBL-004'],
    capability: 'SESSION',
    responses: { 200: { description: 'The floor.', schema: FloorResponse }, ...standardErrors },
  },
  {
    operationId: 'createSection',
    method: 'POST',
    path: '/api/v1/sections',
    summary: 'Add a section, e.g. Ground floor or Terrace',
    description: 'Managers and the Owner (BRD §4.2 "manage staff, sections"). Audited.',
    tags: ['floor'],
    requirements: ['TBL-001', 'ONB-004', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { body: SectionRequest },
    responses: {
      201: { description: 'The new section.', schema: SectionView },
      ...standardErrors,
      409: { description: 'Another section has that name.', schema: ApiError },
    },
  },
  {
    operationId: 'updateSection',
    method: 'PUT',
    path: '/api/v1/sections/:sectionId',
    summary: 'Rename or reorder a section',
    tags: ['floor'],
    requirements: ['TBL-001', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: SectionParams, body: SectionRequest },
    responses: {
      200: { description: 'The section as it is now.', schema: SectionView },
      ...standardErrors,
      404: { description: 'No such section.', schema: ApiError },
      409: { description: 'Archived, or another section has that name.', schema: ApiError },
    },
  },
  {
    operationId: 'archiveSection',
    method: 'POST',
    path: '/api/v1/sections/:sectionId/archive',
    summary: 'Archive an empty section',
    description: 'Its tables must be archived or moved first. Archived, never deleted.',
    tags: ['floor'],
    requirements: ['TBL-001', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: SectionParams, body: FloorArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: SectionView },
      ...standardErrors,
      404: { description: 'No such section.', schema: ApiError },
      409: { description: 'The section still has tables.', schema: ApiError },
    },
  },
  {
    operationId: 'restoreSection',
    method: 'POST',
    path: '/api/v1/sections/:sectionId/restore',
    summary: 'Bring an archived section back',
    tags: ['floor'],
    requirements: ['TBL-001', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: SectionParams },
    responses: {
      200: { description: 'Restored.', schema: SectionView },
      ...standardErrors,
      404: { description: 'No such section.', schema: ApiError },
      409: { description: 'An active section has its name.', schema: ApiError },
    },
  },
  {
    operationId: 'createTable',
    method: 'POST',
    path: '/api/v1/tables',
    summary: 'Add a table to a section',
    description:
      'Labels are unique, archived tables included: restore an archived table instead of ' +
      'adding one with its label. Audited.',
    tags: ['floor'],
    requirements: ['TBL-001', 'ONB-004', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { body: TableRequest },
    responses: {
      201: { description: 'The new table.', schema: TableView },
      ...standardErrors,
      409: { description: 'Another table has that label.', schema: ApiError },
      422: { description: 'No such active section.', schema: ApiError },
    },
  },
  {
    operationId: 'updateTable',
    method: 'PUT',
    path: '/api/v1/tables/:tableId',
    summary: 'Relabel a table, change its seats or move it to another section',
    tags: ['floor'],
    requirements: ['TBL-001', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: TableParams, body: TableRequest },
    responses: {
      200: { description: 'The table as it is now.', schema: TableView },
      ...standardErrors,
      404: { description: 'No such table.', schema: ApiError },
      409: { description: 'Archived, or another table has that label.', schema: ApiError },
      422: { description: 'No such active section.', schema: ApiError },
    },
  },
  {
    operationId: 'archiveTable',
    method: 'POST',
    path: '/api/v1/tables/:tableId/archive',
    summary: 'Archive a free table without a paired tablet',
    tags: ['floor'],
    requirements: ['TBL-001', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: TableParams, body: FloorArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: TableView },
      ...standardErrors,
      404: { description: 'No such table.', schema: ApiError },
      409: { description: 'Guests are seated, or a tablet is paired to it.', schema: ApiError },
    },
  },
  {
    operationId: 'restoreTable',
    method: 'POST',
    path: '/api/v1/tables/:tableId/restore',
    summary: 'Bring an archived table back',
    tags: ['floor'],
    requirements: ['TBL-001', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: TableParams },
    responses: {
      200: { description: 'Restored.', schema: TableView },
      ...standardErrors,
      404: { description: 'No such table.', schema: ApiError },
      409: { description: 'Its section is archived.', schema: ApiError },
    },
  },
  {
    operationId: 'getWaiterAssignments',
    method: 'GET',
    path: '/api/v1/waiter-assignments',
    summary: "Today's waiter assignments, and the previous set to apply again",
    description: 'Waiters read it for "My tables" (WTR-002).',
    tags: ['floor'],
    requirements: ['TBL-002', 'WTR-002'],
    capability: 'SESSION',
    responses: {
      200: { description: 'Assignments.', schema: WaiterAssignmentsResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'updateWaiterAssignments',
    method: 'PUT',
    path: '/api/v1/waiter-assignments',
    summary: "Replace today's waiter assignments (sections and single tables)",
    description:
      'At shift start the manager assigns waiters to sections, and optionally to single tables ' +
      '(TBL-002). Waiters given a table take it over from the section. Audited.',
    tags: ['floor'],
    requirements: ['TBL-002', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { body: UpdateWaiterAssignmentsRequest },
    responses: {
      200: { description: 'Assignments as they are now.', schema: WaiterAssignmentsResponse },
      ...standardErrors,
      422: {
        description: 'An unknown or inactive person, section or table.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'getTableOverview',
    method: 'GET',
    path: '/api/v1/tables/overview',
    summary: 'Every active table with its state, session, waiter and amount so far',
    description:
      'The live table overview (TBL-007). Screens refresh it on table, order and bill events.',
    tags: ['tables'],
    requirements: ['TBL-007', 'WTR-002'],
    capability: 'SESSION',
    responses: {
      200: { description: 'The tables.', schema: TableOverviewResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'openTable',
    method: 'POST',
    path: '/api/v1/tables/:tableId/open',
    summary: 'Seat guests: open a table session with covers and a responsible waiter',
    description:
      'The waiter defaults to the one assigned to the table or its section (TBL-002), else the ' +
      'person opening it. Two devices opening the same table at once: one wins, the other gets 409.',
    tags: ['tables'],
    requirements: ['TBL-003', 'TBL-004', 'AUD-001'],
    capability: 'ORDER_CREATE',
    request: { params: z.object({ tableId: Id }), body: OpenTableRequest },
    responses: {
      201: { description: 'The new session.', schema: TableSessionView },
      ...standardErrors,
      404: { description: 'No such active table.', schema: ApiError },
      409: { description: 'The table is not free.', schema: ApiError },
      422: { description: 'The waiter cannot take tables.', schema: ApiError },
    },
  },
  {
    operationId: 'requestBill',
    method: 'POST',
    path: '/api/v1/table-sessions/:sessionId/request-bill',
    summary: 'Ask for the bill; the cashier is notified',
    tags: ['tables'],
    requirements: ['TBL-004', 'WTR-008'],
    capability: 'BILL_REQUEST',
    request: { params: TableSessionParams },
    responses: {
      200: { description: 'The session as it is now.', schema: TableSessionView },
      ...standardErrors,
      404: { description: 'No such open session.', schema: ApiError },
      409: { description: 'The table is not in a state to ask for the bill.', schema: ApiError },
    },
  },
  {
    operationId: 'closeTableWithoutBill',
    method: 'POST',
    path: '/api/v1/table-sessions/:sessionId/close-without-bill',
    summary: 'Free a table opened by mistake',
    description: 'Only while nothing billable or awaiting approval has been ordered. Audited.',
    tags: ['tables'],
    requirements: ['TBL-004', 'AUD-001'],
    capability: 'ORDER_CREATE',
    request: { params: TableSessionParams, body: CloseWithoutBillRequest },
    responses: {
      200: { description: 'Closed.', schema: TableSessionView },
      ...standardErrors,
      404: { description: 'No such open session.', schema: ApiError },
      409: { description: 'Items have been ordered, or the bill is under way.', schema: ApiError },
    },
  },
  {
    operationId: 'moveTable',
    method: 'POST',
    path: '/api/v1/table-sessions/:sessionId/move',
    summary: 'Move guests, their orders and tickets to a free table',
    description:
      'Kitchen tickets are updated in place (TableMoved to their stations), never duplicated; ' +
      "the old table's tablet resets and the new one's unlocks (TBL-005). Waiters may move " +
      'only their own tables. Audited.',
    tags: ['tables'],
    requirements: ['TBL-005', 'WTR-008', 'AUD-001'],
    capability: 'TABLE_MOVE_MERGE',
    request: { params: TableSessionParams, body: MoveTableRequest },
    responses: {
      200: { description: 'The session at its new table.', schema: TableSessionView },
      ...standardErrors,
      404: { description: 'No such open session or active table.', schema: ApiError },
      409: { description: 'The new table is not free.', schema: ApiError },
    },
  },
  {
    operationId: 'assignSessionWaiter',
    method: 'PUT',
    path: '/api/v1/table-sessions/:sessionId/waiter',
    summary: 'Hand an open table to another waiter',
    tags: ['tables'],
    requirements: ['TBL-002', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: TableSessionParams, body: AssignSessionWaiterRequest },
    responses: {
      200: { description: 'The session as it is now.', schema: TableSessionView },
      ...standardErrors,
      404: { description: 'No such open session.', schema: ApiError },
      422: { description: 'The waiter cannot take tables.', schema: ApiError },
    },
  },
  {
    operationId: 'getMenuDraft',
    method: 'GET',
    path: '/api/v1/menu/draft',
    summary: 'The draft menu for the editor: categories, modifier groups and items',
    description: 'Archived entries included. Ordering surfaces read the published menu instead.',
    tags: ['menu'],
    requirements: ['MGR-005', 'MENU-001', 'MENU-002'],
    capability: 'MENU_MANAGE',
    responses: {
      200: { description: 'The draft menu.', schema: MenuDraftResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createCategory',
    method: 'POST',
    path: '/api/v1/menu/categories',
    summary: 'Add a category',
    description: 'Audited.',
    tags: ['menu'],
    requirements: ['MENU-001', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { body: CategoryRequest },
    responses: {
      201: { description: 'The new category.', schema: CategoryView },
      ...standardErrors,
      409: {
        description: 'Another active category has that name here, or it is not empty.',
        schema: ApiError,
      },
      422: {
        description: 'Something it refers to does not exist or is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'updateCategory',
    method: 'PUT',
    path: '/api/v1/menu/categories/:id',
    summary: 'Change a category',
    description: 'Audited with before and after.',
    tags: ['menu'],
    requirements: ['MENU-001', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: CategoryRequest },
    responses: {
      200: { description: 'The category as it is now.', schema: CategoryView },
      ...standardErrors,
      404: { description: 'No such category.', schema: ApiError },
      409: {
        description: 'Another active category has that name here, or it is not empty.',
        schema: ApiError,
      },
      422: {
        description: 'Something it refers to does not exist or is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'archiveCategory',
    method: 'POST',
    path: '/api/v1/menu/categories/:id/archive',
    summary: 'Archive a category',
    description: 'Archiving needs its items and sub-categories archived or moved first.',
    tags: ['menu'],
    requirements: ['MENU-001', 'MGR-005', 'AUD-001', 'MENU-010'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: MenuArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: CategoryView },
      ...standardErrors,
      404: { description: 'No such category.', schema: ApiError },
      409: { description: 'Still in use.', schema: ApiError },
    },
  },
  {
    operationId: 'restoreCategory',
    method: 'POST',
    path: '/api/v1/menu/categories/:id/restore',
    summary: 'Bring an archived category back',
    tags: ['menu'],
    requirements: ['MENU-001', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams },
    responses: {
      200: { description: 'Restored.', schema: CategoryView },
      ...standardErrors,
      404: { description: 'No such category.', schema: ApiError },
      409: {
        description: 'It clashes with an active entry, or what it belongs to is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'createModifierGroup',
    method: 'POST',
    path: '/api/v1/menu/modifier-groups',
    summary: 'Add a modifier group',
    description: 'Audited.',
    tags: ['menu'],
    requirements: ['MENU-004', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { body: ModifierGroupRequest },
    responses: {
      201: { description: 'The new modifier group.', schema: ModifierGroupView },
      ...standardErrors,
      409: {
        description: 'Another active group has that name, or items use it.',
        schema: ApiError,
      },
      422: {
        description: 'Something it refers to does not exist or is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'updateModifierGroup',
    method: 'PUT',
    path: '/api/v1/menu/modifier-groups/:id',
    summary: 'Change a modifier group',
    description: 'Audited with before and after.',
    tags: ['menu'],
    requirements: ['MENU-004', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: ModifierGroupRequest },
    responses: {
      200: { description: 'The modifier group as it is now.', schema: ModifierGroupView },
      ...standardErrors,
      404: { description: 'No such modifier group.', schema: ApiError },
      409: {
        description: 'Another active group has that name, or items use it.',
        schema: ApiError,
      },
      422: {
        description: 'Something it refers to does not exist or is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'archiveModifierGroup',
    method: 'POST',
    path: '/api/v1/menu/modifier-groups/:id/archive',
    summary: 'Archive a modifier group',
    description: 'Archiving needs it removed from active items first.',
    tags: ['menu'],
    requirements: ['MENU-004', 'MGR-005', 'AUD-001', 'MENU-010'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: MenuArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: ModifierGroupView },
      ...standardErrors,
      404: { description: 'No such modifier group.', schema: ApiError },
      409: { description: 'Still in use.', schema: ApiError },
    },
  },
  {
    operationId: 'restoreModifierGroup',
    method: 'POST',
    path: '/api/v1/menu/modifier-groups/:id/restore',
    summary: 'Bring an archived modifier group back',
    tags: ['menu'],
    requirements: ['MENU-004', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams },
    responses: {
      200: { description: 'Restored.', schema: ModifierGroupView },
      ...standardErrors,
      404: { description: 'No such modifier group.', schema: ApiError },
      409: {
        description: 'It clashes with an active entry, or what it belongs to is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'createItem',
    method: 'POST',
    path: '/api/v1/menu/items',
    summary: 'Add a item',
    description: 'Audited.',
    tags: ['menu'],
    requirements: ['MENU-002', 'MENU-003', 'MENU-011', 'MENU-009', 'INT-005', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { body: ItemRequest },
    responses: {
      201: { description: 'The new item.', schema: ItemView },
      ...standardErrors,
      409: {
        description: 'Another active item has that short code, or it is archived.',
        schema: ApiError,
      },
      422: {
        description: 'Something it refers to does not exist or is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'updateItem',
    method: 'PUT',
    path: '/api/v1/menu/items/:id',
    summary: 'Change a item',
    description: 'Audited with before and after.',
    tags: ['menu'],
    requirements: ['MENU-002', 'MENU-003', 'MENU-011', 'MENU-009', 'INT-005', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: ItemRequest },
    responses: {
      200: { description: 'The item as it is now.', schema: ItemView },
      ...standardErrors,
      404: { description: 'No such item.', schema: ApiError },
      409: {
        description: 'Another active item has that short code, or it is archived.',
        schema: ApiError,
      },
      422: {
        description: 'Something it refers to does not exist or is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'archiveItem',
    method: 'POST',
    path: '/api/v1/menu/items/:id/archive',
    summary: 'Archive a item',
    description: 'Items are never deleted, only archived (MENU-010).',
    tags: ['menu'],
    requirements: [
      'MENU-002',
      'MENU-003',
      'MENU-011',
      'MENU-009',
      'INT-005',
      'MGR-005',
      'AUD-001',
      'MENU-010',
    ],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: MenuArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: ItemView },
      ...standardErrors,
      404: { description: 'No such item.', schema: ApiError },
      409: { description: 'Still in use.', schema: ApiError },
    },
  },
  {
    operationId: 'restoreItem',
    method: 'POST',
    path: '/api/v1/menu/items/:id/restore',
    summary: 'Bring an archived item back',
    tags: ['menu'],
    requirements: ['MENU-002', 'MENU-003', 'MENU-011', 'MENU-009', 'INT-005', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams },
    responses: {
      200: { description: 'Restored.', schema: ItemView },
      ...standardErrors,
      404: { description: 'No such item.', schema: ApiError },
      409: {
        description: 'It clashes with an active entry, or what it belongs to is archived.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'setCombo',
    method: 'PUT',
    path: '/api/v1/menu/items/:id/combo',
    summary: 'Make an item a combo, or change its components',
    description:
      'A fixed-price bundle of items and choice slots, with an optional date range and time ' +
      'window (MENU-005). Components must be active items that are not combos. Audited.',
    tags: ['menu'],
    requirements: ['MENU-005', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { params: MenuEntityParams, body: ComboRequest },
    responses: {
      200: { description: 'The combo.', schema: ComboView },
      ...standardErrors,
      404: { description: 'No such active item.', schema: ApiError },
      422: { description: 'A component is unknown, archived or a combo itself.', schema: ApiError },
    },
  },
  {
    operationId: 'setItemAvailability',
    method: 'PUT',
    path: '/api/v1/menu/items/:id/availability',
    summary: 'Mark an item out of stock or available, or set its remaining quantity',
    description:
      'Applies at once and reaches every device with ItemAvailabilityChanged (MENU-006). Kitchen ' +
      'staff may do it unless the stock.kitchenMayManage setting is off (OI-11). Audited.',
    tags: ['menu'],
    requirements: ['MENU-006', 'OI-11', 'AUD-001'],
    capability: 'STOCK_MANAGE',
    request: { params: MenuEntityParams, body: ItemAvailabilityRequest },
    responses: {
      200: { description: 'Availability as it is now.', schema: ItemAvailabilityView },
      ...standardErrors,
      404: { description: 'No such active item.', schema: ApiError },
    },
  },
  {
    operationId: 'publishMenu',
    method: 'POST',
    path: '/api/v1/menu/publish',
    summary: 'Publish the draft as a new menu version',
    description:
      'Every ordering surface refreshes on MenuPublished (MENU-013). Publishing an unchanged ' +
      'draft returns the current version. Audited.',
    tags: ['menu'],
    requirements: ['MENU-013', 'MENU-012', 'MGR-005', 'AUD-001'],
    capability: 'MENU_MANAGE',
    responses: {
      200: { description: 'The current version.', schema: MenuPublishResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getMenu',
    method: 'GET',
    path: '/api/v1/menu',
    summary: 'The published menu with live availability, for every ordering surface',
    description:
      'For any paired device, including table tablets (MENU-012, MENU-013). Availability and ' +
      'stock are current, not as published (MENU-006).',
    tags: ['menu'],
    requirements: ['MENU-012', 'MENU-013', 'MENU-006'],
    capability: 'DEVICE',
    responses: {
      200: { description: 'The menu.', schema: MenuSnapshot },
      ...deviceErrors,
      404: { description: 'No menu has been published yet.', schema: ApiError },
    },
  },
] as const satisfies readonly RouteDefinition[];
