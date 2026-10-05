import type { Capability } from '@rp/domain';
import { z } from 'zod';
import {
  AlertListResponse,
  AlertParams,
  AlertView,
  BreakRequest,
  BreakView,
  DeviceAlertsResponse,
  NudgeRequest,
  NudgeResponse,
} from './alerts.js';
import { AuditVerifyResponse } from './audit.js';
import {
  BillCustomerRequest,
  BillDiscountParams,
  BillParams,
  BillView,
  DiscountRequest,
  InvoiceParams,
  InvoiceView,
  IssueInvoiceRequest,
  OpenBillRequest,
  PrintInvoiceRequest,
  PrintInvoiceResponse,
  ReopenInvoiceRequest,
  RevokeDiscountRequest,
  ServiceChargeRequest,
  SplitBillRequest,
  SplitBillResponse,
  VoidInvoiceRequest,
} from './billing.js';
import {
  CurrentSessionResponse,
  LoginResponse,
  OverrideRequest,
  OverrideResponse,
  OwnerLoginRequest,
  OwnerPasswordRequest,
  OwnerSecurityResponse,
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
  KdsTicket,
  KdsTicketsQuery,
  KdsTicketParams,
  KdsTicketsResponse,
  NotifyManagerResponse,
} from './kds.js';
import { MenuImportReport, MenuImportRequest, MenuTemplateResponse } from './menu-import.js';
import {
  AssignPagerRequest,
  CreatePagerRequest,
  MyPagerResponse,
  PagerCredentialResponse,
  PagerListResponse,
  PagerParams,
  PagerView,
} from './pagers.js';
import { OrderFeedResponse } from './order-feed.js';
import { PhotoRenditionParams, PhotoView, UploadPhotoRequest } from './photos.js';
import { CloseDayRequest, DayEndParams, DayEndPreview, DayEndView } from './day-end.js';
import {
  BindTableRequest,
  CreatePairingCodeRequest,
  DeviceChallengeRequest,
  DeviceChallengeResponse,
  DeviceListResponse,
  DeviceParams,
  DeviceSummary,
  DeviceTokenRequest,
  DeviceTokenResponse,
  PairDeviceRequest,
  PairedDevice,
  PairingCodeResponse,
  RevokeDeviceRequest,
  UpdateDeviceRequest,
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
import {
  GstSummaryResponse,
  InvoiceRegisterResponse,
  ItemSalesResponse,
  PaymentModesResponse,
  OrderDrillDownParams,
  OrderDrillDownResponse,
  ReportExportRequest,
  ReportExportResponse,
  ReportRangeQuery,
  SalesSummaryResponse,
  ShiftReportResponse,
} from './reports.js';
import {
  CashMovementRequest,
  CloseShiftRequest,
  CurrentShiftResponse,
  InvoicePaymentsView,
  OpenShiftRequest,
  RecordPaymentsRequest,
  ShiftParams,
  ShiftView,
} from './payments.js';
import {
  ModifyOrderItemRequest,
  OrderItemEndRequest,
  OrderItemParams,
  OrderItemStatusRequest,
  OrderListResponse,
  OrderParams,
  OrderView,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from './order.js';
import {
  KotParams,
  KotReprintRequest,
  PrinterListResponse,
  PrinterRedirectRequest,
  PrinterRequest,
  PrinterView,
  PrintingArchiveRequest,
  PrintingParams,
  PrintQueueResponse,
  StationListResponse,
  StationRequest,
  StationView,
  TestPrintResponse,
} from './printing.js';
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
  RecommendationRuleListResponse,
  RecommendationRuleParams,
  RecommendationRuleRequest,
  RecommendationRuleView,
  RecommendationsQuery,
  RecommendationsResponse,
  RecordRecommendationEventsRequest,
  RecordTableRecommendationEventsRequest,
  TableRecommendationsQuery,
} from './recommendations.js';
import {
  RaiseServiceRequest,
  ServiceRequestListResponse,
  ServiceRequestParams,
  ServiceRequestView,
  TableServiceRequestsResponse,
} from './service-requests.js';
import {
  SettingKeyParams,
  SettingsResponse,
  SettingView,
  UpdateSettingRequest,
} from './settings.js';
import { HealthResponse, TlsCaResponse, VersionResponse } from './system.js';
import {
  ArchiveRoleRequest,
  CreateStaffRequest,
  CustomRoleRequest,
  CustomRoleView,
  DeactivateStaffRequest,
  RoleListResponse,
  RoleParams,
  SetStaffPinRequest,
  StaffListResponse,
  StaffParams,
  StaffView,
  UpdateStaffRequest,
} from './staff.js';

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
      404: { description: 'No such open table session.', schema: ApiError },
      409: { description: 'The table is closed, or the bill is being settled.', schema: ApiError },
      422: {
        description: 'The idempotency key was used for a different order, or a note is too long.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'listTakeawayOrders',
    method: 'GET',
    path: '/api/v1/orders/takeaway',
    summary: "Today's open takeaway orders with their tokens and item states",
    tags: ['orders'],
    requirements: ['TBL-008', 'ORD-010'],
    capability: 'ORDER_CREATE',
    responses: {
      200: { description: 'The orders, oldest first.', schema: OrderListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'listSessionOrders',
    method: 'GET',
    path: '/api/v1/table-sessions/:sessionId/orders',
    summary: 'The orders of a table session with their item states',
    tags: ['orders'],
    requirements: ['TBL-007', 'ORD-010'],
    capability: 'ORDER_CREATE',
    request: { params: TableSessionParams },
    responses: {
      200: { description: 'The orders, oldest first.', schema: OrderListResponse },
      ...standardErrors,
      404: { description: 'No such table session.', schema: ApiError },
    },
  },
  {
    operationId: 'getOrder',
    method: 'GET',
    path: '/api/v1/orders/:orderId',
    summary: 'An order with its items, prices, states and tickets',
    tags: ['orders'],
    requirements: ['ORD-009', 'ORD-010'],
    capability: 'ORDER_CREATE',
    request: { params: OrderParams },
    responses: {
      200: { description: 'The order.', schema: OrderView },
      ...standardErrors,
      404: { description: 'No such order.', schema: ApiError },
    },
  },
  {
    operationId: 'getOrderFeed',
    method: 'GET',
    path: '/api/v1/order-feed',
    summary: 'The live order feed: every order with something waiting, cooking or at the pass',
    description:
      'For the manager dashboard (MGR-001, MGR-003): orders with an item waiting for approval, ' +
      'sent, being prepared or ready, oldest first, each with its items, stations, states and ' +
      'times. Dine-in orders leave with their table; takeaway orders with their business date. ' +
      'The dashboard filters by station, waiter, source and table, and marks late items with ' +
      '`@rp/domain` `itemDelay` from `settings` and `serverTime`.',
    tags: ['orders'],
    requirements: ['MGR-001', 'MGR-003'],
    capability: 'OPERATIONS_CONFIGURE',
    responses: {
      200: { description: 'The live orders.', schema: OrderFeedResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getKdsTickets',
    method: 'GET',
    path: '/api/v1/kds/tickets',
    summary: "A station's open kitchen tickets, recently bumped ones and the screen settings",
    description:
      'A kitchen screen in station mode (nobody signed in, AUTH-005) sees its own station and ' +
      'cannot choose another; a signed-in person may pass `stationId`, or see every station.',
    tags: ['kitchen'],
    requirements: ['KDS-001', 'KDS-002', 'KDS-003', 'KDS-004', 'KDS-012'],
    capability: 'ITEM_MARK_PREPARING_READY',
    request: { query: KdsTicketsQuery },
    responses: {
      200: { description: 'The tickets.', schema: KdsTicketsResponse },
      ...standardErrors,
      404: { description: 'No such station.', schema: ApiError },
    },
  },
  {
    operationId: 'bumpKot',
    method: 'POST',
    path: '/api/v1/kds/tickets/:kotId/bump',
    summary: 'Take a finished ticket off the kitchen screen',
    description:
      'Refused while an item on it is still waiting or being prepared. Change and cancellation ' +
      'slips can be bumped once seen.',
    tags: ['kitchen'],
    requirements: ['KDS-005'],
    capability: 'ITEM_MARK_PREPARING_READY',
    request: { params: KdsTicketParams },
    responses: {
      200: { description: 'The ticket, bumped.', schema: KdsTicket },
      ...standardErrors,
      404: { description: 'No such ticket at this station.', schema: ApiError },
      409: { description: 'Items on it are not ready yet.', schema: ApiError },
    },
  },
  {
    operationId: 'recallKot',
    method: 'POST',
    path: '/api/v1/kds/tickets/:kotId/recall',
    summary: 'Bring a bumped ticket back to the kitchen screen',
    tags: ['kitchen'],
    requirements: ['KDS-005'],
    capability: 'ITEM_MARK_PREPARING_READY',
    request: { params: KdsTicketParams },
    responses: {
      200: { description: 'The ticket, back on the screen.', schema: KdsTicket },
      ...standardErrors,
      404: { description: 'No such ticket at this station.', schema: ApiError },
    },
  },
  {
    operationId: 'notifyManagerForKot',
    method: 'POST',
    path: '/api/v1/kds/tickets/:kotId/notify-manager',
    summary: 'Ready food is not being collected: alert the manager',
    description:
      'Raises a READY_NOT_COLLECTED alert for the managers (KDS-006). Pressing it again while the ' +
      'alert is open returns the same alert. Delivery rules and escalation arrive with P2-03.',
    tags: ['kitchen'],
    requirements: ['KDS-006', 'NTF-003'],
    capability: 'ITEM_MARK_PREPARING_READY',
    request: { params: KdsTicketParams },
    responses: {
      200: { description: 'The alert.', schema: NotifyManagerResponse },
      ...standardErrors,
      404: { description: 'No such ticket at this station.', schema: ApiError },
      409: { description: 'Nothing on the ticket is ready and waiting.', schema: ApiError },
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
    description:
      'A manager unlocks their own login and their team’s; the Owner’s and other managers’ ' +
      'only the Owner (P4-02a).',
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
    operationId: 'getOwnerSecurity',
    method: 'GET',
    path: '/api/v1/auth/owner/security',
    summary: "What of the Owner's password, authenticator and recovery codes is set up",
    description:
      'Owner only. Never returns a secret: the console shows what is still to set up and whether ' +
      'the last password + second factor confirmation still holds (AUTH-006).',
    tags: ['auth'],
    requirements: ['AUTH-006'],
    capability: 'SESSION',
    responses: {
      200: { description: 'What is set up.', schema: OwnerSecurityResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'listStaff',
    method: 'GET',
    path: '/api/v1/staff',
    summary: 'Everyone who works here, active or not, with their role and PIN status',
    description:
      'MGR-004: never the PIN itself, only whether one is set and whether the sign-in is locked ' +
      '(AUTH-003); with the PIN length a new PIN must have (AUTH-001).',
    tags: ['staff'],
    requirements: ['MGR-004', 'AUTH-001', 'AUTH-003'],
    capability: 'STAFF_MANAGE',
    responses: {
      200: { description: 'Staff.', schema: StaffListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createStaff',
    method: 'POST',
    path: '/api/v1/staff',
    summary: 'Add a person with a role and a PIN',
    description:
      'MGR-004. Managers add cashiers, waiters and kitchen staff; adding a manager needs the Owner ' +
      'with a fresh second factor (403 `SECOND_FACTOR_REQUIRED` until then, AUTH-006). A custom ' +
      'role (AUTH-012) is given like its base role, except that one built on the manager role or ' +
      'giving staff management counts as a manager. The PIN has exactly `auth.pinLength` digits, ' +
      'is hashed with the pepper and never stored or logged (AUTH-002). Audited.',
    tags: ['staff'],
    requirements: ['MGR-004', 'AUTH-001', 'AUTH-002', 'AUTH-006', 'AUTH-012', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { body: CreateStaffRequest },
    responses: {
      201: { description: 'The new person.', schema: StaffView },
      ...standardErrors,
      404: { description: 'No such custom role, or it is archived.', schema: ApiError },
      422: {
        description:
          'The PIN does not have the configured length, or the custom role is built on another role.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'updateStaff',
    method: 'PATCH',
    path: '/api/v1/staff/:staffId',
    summary: "Change a person's name, role, phone or e-mail",
    description:
      "MGR-004. A new role, or custom role (AUTH-012), applies to the person's next request and " +
      "closes their live connections (AUTH-010). Making someone a manager or no longer one needs the Owner's " +
      'second factor (AUTH-006), as does giving or taking away a custom role built on the manager ' +
      "role or giving staff management; a manager's details are changed by the Owner or " +
      'themselves; nobody changes their own role. Audited with before and after.',
    tags: ['staff'],
    requirements: ['MGR-004', 'AUTH-006', 'AUTH-012', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: StaffParams, body: UpdateStaffRequest },
    responses: {
      200: { description: 'The person as they are now.', schema: StaffView },
      ...standardErrors,
      404: { description: 'No such person, or no such active custom role.', schema: ApiError },
      422: {
        description:
          'The change is not allowed on this record, or the custom role is built on another role.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'deactivateStaff',
    method: 'POST',
    path: '/api/v1/staff/:staffId/deactivate',
    summary: 'Deactivate a person: signed out everywhere, kept in the records',
    description:
      'MGR-004, AUTH-008: never deleted. Their sessions end and live connections close within 5 ' +
      "s; their pager and waiter phone are taken back and they leave today's sections. " +
      "Deactivating a manager needs the Owner's second factor (AUTH-006). Audited with the reason.",
    tags: ['staff'],
    requirements: ['MGR-004', 'AUTH-006', 'AUTH-008', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: StaffParams, body: DeactivateStaffRequest },
    responses: {
      200: { description: 'The person, inactive.', schema: StaffView },
      ...standardErrors,
      404: { description: 'No such person.', schema: ApiError },
      409: { description: 'They are already inactive.', schema: ApiError },
      422: { description: 'The Owner, or the person asking.', schema: ApiError },
    },
  },
  {
    operationId: 'reactivateStaff',
    method: 'POST',
    path: '/api/v1/staff/:staffId/reactivate',
    summary: 'Let a deactivated person sign in again',
    description:
      "MGR-004. Reactivating a manager needs the Owner's second factor (AUTH-006). Audited.",
    tags: ['staff'],
    requirements: ['MGR-004', 'AUTH-006', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: StaffParams },
    responses: {
      200: { description: 'The person, active.', schema: StaffView },
      ...standardErrors,
      404: { description: 'No such person.', schema: ApiError },
      409: { description: 'They are already active.', schema: ApiError },
    },
  },
  {
    operationId: 'setStaffPin',
    method: 'PUT',
    path: '/api/v1/staff/:staffId/pin',
    summary: "Set or reset a person's PIN",
    description:
      'MGR-004, AUTH-001, AUTH-002: exactly `auth.pinLength` digits, hashed with the pepper, never ' +
      "stored, logged or shown. Clears a lockout (AUTH-003). A manager's PIN is set by the Owner " +
      "or themselves, the Owner's only by the Owner. Audited without the PIN.",
    tags: ['staff'],
    requirements: ['MGR-004', 'AUTH-001', 'AUTH-002', 'AUTH-003', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: StaffParams, body: SetStaffPinRequest },
    responses: {
      204: { description: 'PIN set.' },
      ...standardErrors,
      404: { description: 'No such person.', schema: ApiError },
      422: { description: 'The PIN does not have the configured length.', schema: ApiError },
    },
  },
  {
    operationId: 'listRoles',
    method: 'GET',
    path: '/api/v1/roles',
    summary: 'The custom roles: what each adds to or takes from its base role',
    description:
      'AUTH-012: archived roles included, with how many active people have each, so the staff ' +
      'editor can offer them.',
    tags: ['staff'],
    requirements: ['AUTH-012', 'MGR-004'],
    capability: 'STAFF_MANAGE',
    responses: {
      200: { description: 'Custom roles.', schema: RoleListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createRole',
    method: 'POST',
    path: '/api/v1/roles',
    summary: 'The Owner combines permissions into a new role on top of a base role',
    description:
      'AUTH-012. Only the Owner, with a fresh second factor (403 `SECOND_FACTOR_REQUIRED` until ' +
      'then, AUTH-006). It may add anything a manager may do and take away anything the base role ' +
      'may do, never what only the Owner may do (422 `ROLE_PERMISSIONS_INVALID` with each ' +
      'problem). Names are unique among active roles, built-in ones included. Audited.',
    tags: ['staff'],
    requirements: ['AUTH-012', 'AUTH-006', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { body: CustomRoleRequest },
    responses: {
      201: { description: 'The new role.', schema: CustomRoleView },
      ...standardErrors,
      409: { description: 'Another active role has that name.', schema: ApiError },
      422: { description: 'Permissions that cannot be given this way.', schema: ApiError },
    },
  },
  {
    operationId: 'updateRole',
    method: 'PUT',
    path: '/api/v1/roles/:roleId',
    summary: "Change a custom role's name, base role or permissions",
    description:
      'AUTH-012, AUTH-006: the Owner with a fresh second factor. The people who have it work with ' +
      'the new permissions from their next request; their live connections close, so their ' +
      'screens sign in again with them. Audited with before and after.',
    tags: ['staff'],
    requirements: ['AUTH-012', 'AUTH-006', 'AUTH-010', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: RoleParams, body: CustomRoleRequest },
    responses: {
      200: { description: 'The role as it is now.', schema: CustomRoleView },
      ...standardErrors,
      404: { description: 'No such custom role.', schema: ApiError },
      409: { description: 'Archived, or another active role has that name.', schema: ApiError },
      422: { description: 'Permissions that cannot be given this way.', schema: ApiError },
    },
  },
  {
    operationId: 'archiveRole',
    method: 'POST',
    path: '/api/v1/roles/:roleId/archive',
    summary: 'Archive a custom role nobody active has',
    description:
      'AUTH-012, AUTH-006: the Owner with a fresh second factor, with a reason. Deactivated people ' +
      'keep it in their records. Audited.',
    tags: ['staff'],
    requirements: ['AUTH-012', 'AUTH-006', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: RoleParams, body: ArchiveRoleRequest },
    responses: {
      200: { description: 'The role, archived.', schema: CustomRoleView },
      ...standardErrors,
      404: { description: 'No such custom role.', schema: ApiError },
      409: { description: 'Already archived, or active people have it.', schema: ApiError },
    },
  },
  {
    operationId: 'restoreRole',
    method: 'POST',
    path: '/api/v1/roles/:roleId/restore',
    summary: 'Offer an archived custom role again',
    description: 'AUTH-012, AUTH-006: the Owner with a fresh second factor. Audited.',
    tags: ['staff'],
    requirements: ['AUTH-012', 'AUTH-006', 'AUD-001'],
    capability: 'STAFF_MANAGE',
    request: { params: RoleParams },
    responses: {
      200: { description: 'The role, offered again.', schema: CustomRoleView },
      ...standardErrors,
      404: { description: 'No such custom role.', schema: ApiError },
      409: { description: 'Not archived, or another active role has its name.', schema: ApiError },
    },
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
    summary: 'Paired and revoked devices of the restaurant, with their state now',
    description:
      'Each device with its binding, whether it is connected now, its battery against the low ' +
      'level of its type, and its app and firmware versions (MGR-006). Keys are never listed.',
    tags: ['devices'],
    requirements: ['AUTH-007', 'AUTH-008', 'MGR-006', 'TAB-015'],
    capability: 'DEVICE_PAIR',
    responses: { 200: { description: 'Devices.', schema: DeviceListResponse }, ...standardErrors },
  },
  {
    operationId: 'renameDevice',
    method: 'PATCH',
    path: '/api/v1/devices/:deviceId',
    summary: 'Rename a device',
    description: 'Audited. The device and every device list hear of it (`RestaurantChanged`).',
    tags: ['devices'],
    requirements: ['MGR-006', 'AUD-001'],
    capability: 'DEVICE_PAIR',
    request: { params: DeviceParams, body: UpdateDeviceRequest },
    responses: {
      200: { description: 'Renamed.', schema: DeviceSummary },
      ...standardErrors,
      404: { description: 'No such device.', schema: ApiError },
      409: { description: 'The device is unpaired.', schema: ApiError },
    },
  },
  {
    operationId: 'locateDevice',
    method: 'POST',
    path: '/api/v1/devices/:deviceId/locate',
    summary: 'Make a device show itself: a screen sounds, a tablet beeps, a pager vibrates',
    description:
      'Only while the device is connected: the request is refused otherwise, and a device that ' +
      'connects later does not hear it (`DeviceLocateRequested`, MGR-006).',
    tags: ['devices'],
    requirements: ['MGR-006'],
    capability: 'DEVICE_PAIR',
    request: { params: DeviceParams },
    responses: {
      204: { description: 'The device was asked to show itself.' },
      ...standardErrors,
      404: { description: 'No such device.', schema: ApiError },
      409: { description: 'The device is unpaired or not connected.', schema: ApiError },
    },
  },
  {
    operationId: 'revokeDevice',
    method: 'POST',
    path: '/api/v1/devices/:deviceId/revoke',
    summary: 'Unpair a device: its tokens and sessions stop working at once',
    description:
      'Its live connections close within 5 seconds, a pager is disconnected from the broker, and ' +
      'its device alerts are cleared. Audited with the reason.',
    tags: ['devices'],
    requirements: ['AUTH-008', 'MGR-006'],
    capability: 'DEVICE_PAIR',
    request: { params: DeviceParams, body: RevokeDeviceRequest },
    responses: { 200: { description: 'Revoked.', schema: DeviceSummary }, ...standardErrors },
  },
  {
    operationId: 'bindTabletTable',
    method: 'PUT',
    path: '/api/v1/devices/:deviceId/table',
    summary: 'Move a table tablet to another table',
    description:
      'Needs a manager (AUTH-009); the tablet then serves only the new table, and its live ' +
      'connection restarts in the new table’s rooms. Audited.',
    tags: ['devices'],
    requirements: ['AUTH-009', 'TAB-002'],
    capability: 'DEVICE_PAIR',
    request: { params: DeviceParams, body: BindTableRequest },
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
    operationId: 'menuImportTemplate',
    method: 'GET',
    path: '/api/v1/menu/import/template',
    summary: 'The vendor menu template (.xlsx)',
    description:
      'ONB-005. Sheets Items, Variants, Modifiers and Combos, with a notes row under each header ' +
      'saying what goes in each column. The notes row is skipped on import.',
    tags: ['menu'],
    requirements: ['ONB-005'],
    capability: 'MENU_MANAGE',
    responses: {
      200: { description: 'The workbook, base64.', schema: MenuTemplateResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'checkMenuImport',
    method: 'POST',
    path: '/api/v1/menu/import/check',
    summary: 'Check a menu file and list every problem, writing nothing',
    description:
      'ONB-005, MENU-011. Each problem names its sheet, row and column. Items, categories, ' +
      'modifier groups and combos are added; existing items are never changed, and tax groups ' +
      'and kitchen stations are referred to by name.',
    tags: ['menu'],
    requirements: ['ONB-005', 'ONB-009', 'MENU-011'],
    capability: 'MENU_MANAGE',
    request: { body: MenuImportRequest },
    responses: {
      200: { description: 'The report.', schema: MenuImportReport },
      ...standardErrors,
    },
  },
  {
    operationId: 'importMenu',
    method: 'POST',
    path: '/api/v1/menu/import',
    summary: 'Import a menu file and publish it',
    description:
      'ONB-005, ONB-009. Checks the file as the check does; with no problems, adds everything in ' +
      'one transaction, audited, and publishes a new menu version. With problems nothing is ' +
      'written and the report lists them.',
    tags: ['menu'],
    requirements: ['ONB-005', 'ONB-009', 'MENU-011', 'MENU-013', 'AUD-001'],
    capability: 'MENU_MANAGE',
    request: { body: MenuImportRequest },
    responses: {
      200: {
        description: 'The report; `committed` says whether it was imported.',
        schema: MenuImportReport,
      },
      ...standardErrors,
    },
  },
  {
    operationId: 'uploadPhoto',
    method: 'POST',
    path: '/api/v1/photos',
    summary: 'Upload a photo for a menu item, the logo or a staff member',
    description:
      'MENU-008, SEC-004. At most 5 MB. The content decides the format (JPEG, PNG, WebP or ' +
      'HEIF/AVIF), not the claimed type; anything else is refused. The image is turned upright, ' +
      're-encoded to WebP renditions 160, 480 and 960 px wide and stored without EXIF or other ' +
      'metadata. Choose the photo afterwards on the item, logo or staff record.',
    tags: ['photos'],
    requirements: ['MENU-008', 'SEC-004'],
    capability: 'MENU_MANAGE',
    request: { body: UploadPhotoRequest },
    responses: {
      201: { description: 'The stored photo and its renditions.', schema: PhotoView },
      ...standardErrors,
      413: { description: 'Larger than 5 MB, or too many pixels.', schema: ApiError },
      415: { description: 'Not an image in an accepted format.', schema: ApiError },
    },
  },
  {
    operationId: 'getPhotoRendition',
    method: 'GET',
    path: '/api/v1/photos/:id/:width',
    summary: 'One WebP rendition of a photo',
    description:
      'MENU-008. Public so that an `<img>` on any screen can load it without a token: menu ' +
      'photos are shown to guests on the public QR menu anyway, ids are random UUIDs, and the ' +
      'files hold no metadata. Renditions never change, so they are cached for a year.',
    tags: ['photos'],
    requirements: ['MENU-008'],
    capability: 'PUBLIC',
    request: { params: PhotoRenditionParams },
    responses: {
      200: { description: 'The image (image/webp).' },
      400: standardErrors[400],
      404: { description: 'No such photo.', schema: ApiError },
    },
  },
  {
    operationId: 'listAlerts',
    method: 'GET',
    path: '/api/v1/alerts',
    summary: 'Open alerts for the signed-in person',
    description:
      'NTF-006: a device fetches this on start and after reconnecting, so no alert is missed. ' +
      'Managers and the Owner see every open alert of the restaurant.',
    tags: ['notifications'],
    requirements: ['NTF-001', 'NTF-006'],
    capability: 'SESSION',
    responses: {
      200: { description: 'Open alerts, oldest first.', schema: AlertListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'acknowledgeAlert',
    method: 'POST',
    path: '/api/v1/alerts/:alertId/acknowledge',
    summary: 'Acknowledge an alert, which stops its repeats and escalation everywhere',
    description:
      'NTF-004: a recipient, a manager or the Owner. Acknowledging again returns the alert as it ' +
      'is. The time is kept for reports.',
    tags: ['notifications'],
    requirements: ['NTF-004', 'NTF-005'],
    capability: 'SESSION',
    request: { params: AlertParams },
    responses: {
      200: { description: 'The alert.', schema: AlertView },
      ...standardErrors,
      404: { description: 'No such alert, or not one for you.', schema: ApiError },
    },
  },
  {
    operationId: 'listDeviceAlerts',
    method: 'GET',
    path: '/api/v1/devices/current/alerts',
    summary: "This waiter phone's alerts: those of the person it alerts",
    description:
      "WTR-006, NTF-006: the open alerts of the phone's holder, the person who last signed in " +
      'on it, that go to their pager or app, oldest first. The holder stays after an inactivity ' +
      'sign-out, so the phone keeps alerting like a pager; signing out on the phone, signing in ' +
      'on another phone or unpairing ends it. Only waiter phones.',
    tags: ['notifications'],
    requirements: ['WTR-006', 'NTF-006', 'AUTH-005'],
    capability: 'DEVICE',
    responses: {
      200: { description: 'The holder and their open alerts.', schema: DeviceAlertsResponse },
      ...deviceErrors,
      403: { description: 'Not a waiter phone.', schema: ApiError },
    },
  },
  {
    operationId: 'acknowledgeDeviceAlert',
    method: 'POST',
    path: '/api/v1/devices/current/alerts/:alertId/acknowledge',
    summary: "Acknowledge one of the phone's alerts, as its holder",
    description:
      "WTR-006, NTF-004: like the button on the pager, the phone acknowledges its holder's " +
      'alert in their name, signed in or not, which stops its repeats and escalation everywhere. ' +
      'Acknowledging again returns the alert as it is.',
    tags: ['notifications'],
    requirements: ['WTR-006', 'NTF-004'],
    capability: 'DEVICE',
    request: { params: AlertParams },
    responses: {
      200: { description: 'The alert.', schema: AlertView },
      ...deviceErrors,
      403: { description: 'Not a waiter phone.', schema: ApiError },
      404: { description: "No such alert for the phone's holder.", schema: ApiError },
    },
  },
  {
    operationId: 'nudgeStaff',
    method: 'POST',
    path: '/api/v1/alerts/nudge',
    summary: 'Nudge waiters with a preset or a short message on their pager and app',
    description:
      'NTF-008: one alert per person, "MGR: <message>" on the pager, repeated every R until ' +
      'acknowledged; the acknowledgement time is kept. Presets are the setting ' +
      '`notifications.nudgePresets`; any text up to 40 characters is allowed.',
    tags: ['notifications'],
    requirements: ['NTF-008', 'NTF-004'],
    capability: 'STAFF_MANAGE',
    request: { body: NudgeRequest },
    responses: {
      201: { description: 'The alerts, one per person.', schema: NudgeResponse },
      ...standardErrors,
      422: { description: 'Someone chosen is not active staff here.', schema: ApiError },
    },
  },
  {
    operationId: 'setMyBreak',
    method: 'POST',
    path: '/api/v1/staff/me/break',
    summary: 'Start or end "On break" for the signed-in person',
    description:
      "NTF-009: while on break the person's alerts go to the managers on duty. Setting the same " +
      'value again changes nothing.',
    tags: ['notifications'],
    requirements: ['NTF-009'],
    capability: 'SESSION',
    request: { body: BreakRequest },
    responses: {
      200: { description: 'The break state.', schema: BreakView },
      ...standardErrors,
    },
  },
  {
    operationId: 'listServiceRequests',
    method: 'GET',
    path: '/api/v1/service-requests',
    summary: "Open water, waiter and bill requests: the waiter's inbox",
    description:
      'WTR-005: every open request of the restaurant, oldest first, with its table and who is on ' +
      "the way; the app shows those of the waiter's tables. Read again after service request " +
      'events.',
    tags: ['service-requests'],
    requirements: ['WTR-005', 'TBL-007'],
    capability: 'ORDER_CREATE',
    responses: {
      200: { description: 'Open requests, oldest first.', schema: ServiceRequestListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'acknowledgeServiceRequest',
    method: 'POST',
    path: '/api/v1/service-requests/:requestId/acknowledge',
    summary: 'Say you are on the way: the tablet shows "Waiter is on the way"',
    description:
      'WTR-005, NTF-004: acknowledges the request and its alert, which stops the repeats and the ' +
      'escalation everywhere. A request acknowledged or closed already is returned as it is.',
    tags: ['service-requests'],
    requirements: ['WTR-005', 'NTF-004', 'TAB-004'],
    capability: 'ORDER_CREATE',
    request: { params: ServiceRequestParams },
    responses: {
      200: { description: 'The request.', schema: ServiceRequestView },
      ...standardErrors,
      404: { description: 'No such request.', schema: ApiError },
    },
  },
  {
    operationId: 'resolveServiceRequest',
    method: 'POST',
    path: '/api/v1/service-requests/:requestId/resolve',
    summary: 'Clear a request that was dealt with, like Cancel on the tablet',
    description:
      'WTR-005: a request nobody acknowledged yet is acknowledged first (the time counts for ' +
      'reports), then resolved; the tablet clears it. A closed request is returned as it is.',
    tags: ['service-requests'],
    requirements: ['WTR-005', 'TAB-004', 'NTF-004'],
    capability: 'ORDER_CREATE',
    request: { params: ServiceRequestParams },
    responses: {
      200: { description: 'The request.', schema: ServiceRequestView },
      ...standardErrors,
      404: { description: 'No such request.', schema: ApiError },
    },
  },
  {
    operationId: 'listTableServiceRequests',
    method: 'GET',
    path: '/api/v1/devices/current/service-requests',
    summary: "This table tablet's open requests",
    description:
      "TAB-004, AUTH-009: the open requests of the session at the tablet's own table, for " +
      '"Requested, waiter notified" with the time and "Waiter is on the way". Only table tablets.',
    tags: ['service-requests'],
    requirements: ['TAB-004', 'AUTH-009'],
    capability: 'DEVICE',
    responses: {
      200: {
        description: 'The open session and its requests.',
        schema: TableServiceRequestsResponse,
      },
      ...deviceErrors,
      403: { description: 'Not a table tablet bound to a table.', schema: ApiError },
    },
  },
  {
    operationId: 'raiseServiceRequest',
    method: 'POST',
    path: '/api/v1/devices/current/service-requests',
    summary: 'Water, Waiter or Bill from the table tablet',
    description:
      'TAB-004, BILL-015: alerts the responsible waiter (and the cashier for the bill, which also ' +
      'sets the table to Bill requested), repeating every R until acknowledged and escalating to ' +
      'the managers after N. The same type cannot be raised again while one is open, and a tablet ' +
      'may raise only `tablet.serviceRequestsPerMinute` requests a minute (SEC-009).',
    tags: ['service-requests'],
    requirements: ['TAB-004', 'BILL-015', 'NTF-003', 'NTF-005', 'SEC-009'],
    capability: 'DEVICE',
    request: { body: RaiseServiceRequest },
    responses: {
      201: { description: 'The request, active.', schema: ServiceRequestView },
      ...deviceErrors,
      403: { description: 'Not a table tablet bound to a table.', schema: ApiError },
      409: {
        description: 'The table is not open, or a request of this type is already open.',
        schema: ApiError,
      },
      429: { description: 'Too many requests from this tablet this minute.', schema: ApiError },
    },
  },
  {
    operationId: 'cancelTableServiceRequest',
    method: 'POST',
    path: '/api/v1/devices/current/service-requests/:requestId/cancel',
    summary: 'Cancel on the table tablet, like a cabin call button',
    description:
      'TAB-004: a request not yet acknowledged is cancelled (no longer needed) and its alert ' +
      'cleared; one acknowledged is resolved (the waiter arrived). Only requests of the ' +
      "tablet's own table; a closed request is returned as it is.",
    tags: ['service-requests'],
    requirements: ['TAB-004', 'AUTH-009'],
    capability: 'DEVICE',
    request: { params: ServiceRequestParams },
    responses: {
      200: { description: 'The request.', schema: ServiceRequestView },
      ...deviceErrors,
      403: { description: 'Not a table tablet bound to a table.', schema: ApiError },
      404: { description: 'No such request at this table.', schema: ApiError },
    },
  },
  {
    operationId: 'getRecommendations',
    method: 'GET',
    path: '/api/v1/recommendations',
    summary: "Suggestions for a table's order, each with its reason",
    description:
      'REC-001 to REC-006: the rules the order triggers (by priority), then learned pairings, then ' +
      'best sellers of the time of day, without what cannot be served on the channel now, what is ' +
      'in the order already unless repeatable, and anything not veg for a veg-only table; the next ' +
      'course first. `cart` names the items not yet sent; the sent ones are read from the table ' +
      'session. Without a table session, from the cart alone. Table-level only (REC-007).',
    tags: ['recommendations'],
    requirements: [
      'REC-001',
      'REC-002',
      'REC-004',
      'REC-005',
      'REC-006',
      'REC-007',
      'REC-011',
      'WTR-011',
    ],
    capability: 'ORDER_CREATE',
    request: { query: RecommendationsQuery },
    responses: {
      200: { description: 'Suggestions, best first.', schema: RecommendationsResponse },
      ...standardErrors,
      404: { description: 'No such table session, or no menu published yet.', schema: ApiError },
      409: { description: 'The table session is closed.', schema: ApiError },
    },
  },
  {
    operationId: 'getTableRecommendations',
    method: 'GET',
    path: '/api/v1/devices/current/recommendations',
    summary: "Suggestions for this table tablet's table",
    description:
      "TAB-011, AUTH-009: as `getRecommendations` for the session open at the tablet's own " +
      'table, on the tablet channel. Only table tablets.',
    tags: ['recommendations'],
    requirements: ['TAB-011', 'REC-001', 'REC-005', 'REC-006', 'REC-007', 'REC-011', 'AUTH-009'],
    capability: 'DEVICE',
    request: { query: TableRecommendationsQuery },
    responses: {
      200: { description: 'Suggestions, best first.', schema: RecommendationsResponse },
      ...deviceErrors,
      403: { description: 'Not a table tablet bound to a table.', schema: ApiError },
      404: { description: 'No menu published yet.', schema: ApiError },
      409: { description: 'The table is not open.', schema: ApiError },
    },
  },
  {
    operationId: 'recordRecommendationEvents',
    method: 'POST',
    path: '/api/v1/recommendations/events',
    summary: 'Count suggestions shown, opened and put in the cart',
    description:
      'REC-008: up to 50 events per call, for a table session open or just closed (events sent ' +
      'in batches may arrive after the bill). An order line sent with its `recommendation` is ' +
      'counted as ORDERED by the server; clients never send ORDERED.',
    tags: ['recommendations'],
    requirements: ['REC-008'],
    capability: 'ORDER_CREATE',
    request: { body: RecordRecommendationEventsRequest },
    responses: {
      204: { description: 'Recorded.' },
      ...standardErrors,
      404: { description: 'No such table session.', schema: ApiError },
      422: { description: 'An item or rule does not exist here.', schema: ApiError },
    },
  },
  {
    operationId: 'recordTableRecommendationEvents',
    method: 'POST',
    path: '/api/v1/devices/current/recommendations/events',
    summary: "Count this table tablet's suggestions shown, opened and put in the cart",
    description: "REC-008, AUTH-009: for the session open at the tablet's own table.",
    tags: ['recommendations'],
    requirements: ['REC-008', 'TAB-011', 'AUTH-009'],
    capability: 'DEVICE',
    request: { body: RecordTableRecommendationEventsRequest },
    responses: {
      204: { description: 'Recorded.' },
      ...deviceErrors,
      403: { description: 'Not a table tablet bound to a table.', schema: ApiError },
      409: { description: 'The table is not open.', schema: ApiError },
      422: { description: 'An item or rule does not exist here.', schema: ApiError },
    },
  },
  {
    operationId: 'listRecommendationRules',
    method: 'GET',
    path: '/api/v1/recommendation-rules',
    summary: 'The recommendation rules, highest priority first',
    description: 'REC-002: every rule not archived, paused ones included. The editor is P4-03.',
    tags: ['recommendations'],
    requirements: ['REC-002'],
    capability: 'OPERATIONS_CONFIGURE',
    responses: {
      200: { description: 'The rules.', schema: RecommendationRuleListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createRecommendationRule',
    method: 'POST',
    path: '/api/v1/recommendation-rules',
    summary: 'Add a rule: if the order contains X, suggest Y',
    description:
      'REC-002: X and Y are active items or categories (a category includes its ' +
      'sub-categories). Audited.',
    tags: ['recommendations'],
    requirements: ['REC-002', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { body: RecommendationRuleRequest },
    responses: {
      201: { description: 'The new rule.', schema: RecommendationRuleView },
      ...standardErrors,
      422: { description: 'An item or category it names is not active here.', schema: ApiError },
    },
  },
  {
    operationId: 'updateRecommendationRule',
    method: 'PUT',
    path: '/api/v1/recommendation-rules/:ruleId',
    summary: 'Change or pause a rule',
    description: 'REC-002: audited with before and after. An archived rule cannot be changed.',
    tags: ['recommendations'],
    requirements: ['REC-002', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: RecommendationRuleParams, body: RecommendationRuleRequest },
    responses: {
      200: { description: 'The rule as it is now.', schema: RecommendationRuleView },
      ...standardErrors,
      404: { description: 'No such rule, or it is archived.', schema: ApiError },
      422: { description: 'An item or category it names is not active here.', schema: ApiError },
    },
  },
  {
    operationId: 'archiveRecommendationRule',
    method: 'POST',
    path: '/api/v1/recommendation-rules/:ruleId/archive',
    summary: 'Remove a rule for good',
    description:
      'REC-002: rules are archived, never deleted, so what they suggested stays in the reports ' +
      '(REC-008). Audited with the reason. Archiving an archived rule changes nothing.',
    tags: ['recommendations'],
    requirements: ['REC-002', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: RecommendationRuleParams, body: ArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: RecommendationRuleView },
      ...standardErrors,
      404: { description: 'No such rule.', schema: ApiError },
    },
  },
  {
    operationId: 'listPagers',
    method: 'GET',
    path: '/api/v1/pagers',
    summary: "The restaurant's pagers with wearer, battery, signal and connection",
    tags: ['pagers'],
    requirements: ['PGR-007', 'PGR-012'],
    capability: 'DEVICE_PAIR',
    responses: {
      200: { description: 'Pagers.', schema: PagerListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getMyPager',
    method: 'GET',
    path: '/api/v1/pagers/mine',
    summary: "The signed-in person's own pager with battery and connection",
    description:
      'WTR-014: the waiter app shows it and warns when the pager is offline or its battery is at ' +
      'or below `lowBatteryPercent`. Read again on `DeviceStatusChanged`, which reaches the wearer.',
    tags: ['pagers'],
    requirements: ['WTR-014', 'PGR-007', 'PGR-013'],
    capability: 'SESSION',
    responses: {
      200: {
        description: 'The pager, or null when the person wears none.',
        schema: MyPagerResponse,
      },
      ...standardErrors,
    },
  },
  {
    operationId: 'createPager',
    method: 'POST',
    path: '/api/v1/pagers',
    summary: 'Register a pager by its serial and get the credential to write into it',
    description:
      'PGR-012, SEC-012: a unique MQTT credential per pager, shown only in this answer (stored ' +
      'hashed). The pager may read only its own alerts topic and write only its own ack and ' +
      'heartbeat topics. Audited.',
    tags: ['pagers'],
    requirements: ['PGR-005', 'PGR-012', 'SEC-012', 'AUD-001'],
    capability: 'DEVICE_PAIR',
    request: { body: CreatePagerRequest },
    responses: {
      201: { description: 'The pager and its credential.', schema: PagerCredentialResponse },
      ...standardErrors,
      409: { description: 'A pager with this serial is already registered.', schema: ApiError },
      422: { description: 'The wearer is not active staff here.', schema: ApiError },
    },
  },
  {
    operationId: 'rotatePagerCredential',
    method: 'POST',
    path: '/api/v1/pagers/:deviceId/credential',
    summary: 'Issue a new credential for a pager; the old one stops working at once',
    tags: ['pagers'],
    requirements: ['SEC-012', 'AUD-001'],
    capability: 'DEVICE_PAIR',
    request: { params: PagerParams },
    responses: {
      200: { description: 'The new credential.', schema: PagerCredentialResponse },
      ...standardErrors,
      404: { description: 'No such pager.', schema: ApiError },
    },
  },
  {
    operationId: 'assignPager',
    method: 'PUT',
    path: '/api/v1/pagers/:deviceId/wearer',
    summary: 'Give a pager to a waiter or manager, or take it back',
    description:
      "PGR-012, PGR-014: effective at once; the pager's open alerts are sent again for the new " +
      'wearer. A person wears one pager: giving them this one takes any other from them. Audited.',
    tags: ['pagers'],
    requirements: ['PGR-012', 'PGR-014', 'AUD-001'],
    capability: 'DEVICE_PAIR',
    request: { params: PagerParams, body: AssignPagerRequest },
    responses: {
      200: { description: 'The pager.', schema: PagerView },
      ...standardErrors,
      404: { description: 'No such pager.', schema: ApiError },
      422: { description: 'The wearer is not active staff here.', schema: ApiError },
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
  {
    operationId: 'setOrderItemStatus',
    method: 'POST',
    path: '/api/v1/order-items/:orderItemId/status',
    summary: 'Move an item along: preparing, ready, picked up, served',
    description:
      'Each step needs its own grant (BRD §4.2): the kitchen marks preparing and ready, the floor ' +
      'picks up and serves. A combo line moves its parts with it. Returns the order. A kitchen ' +
      'screen in station mode (nobody signed in, AUTH-005) acts with the kitchen grants on its ' +
      "own station's items only.",
    tags: ['orders'],
    requirements: ['ORD-010', 'ORD-002', 'KDS-005', 'KDS-007'],
    capability: 'SESSION',
    request: { params: OrderItemParams, body: OrderItemStatusRequest },
    responses: {
      200: { description: 'The order as it is now.', schema: OrderView },
      ...standardErrors,
      404: { description: 'No such order item.', schema: ApiError },
      409: { description: 'The item is not in a state for this step.', schema: ApiError },
    },
  },
  {
    operationId: 'cancelOrderItem',
    method: 'POST',
    path: '/api/v1/order-items/:orderItemId/cancel',
    summary: 'Cancel an item the kitchen has not started, with a reason',
    description:
      'Waiters may cancel only on their own tables. The station gets a CANCELLED ticket slip and ' +
      'counted stock is returned (ORD-011, ORD-012). Audited.',
    tags: ['orders'],
    requirements: ['ORD-011', 'ORD-012', 'AUD-001'],
    capability: 'ITEM_CANCEL_BEFORE_PREP',
    request: { params: OrderItemParams, body: OrderItemEndRequest },
    responses: {
      200: { description: 'The order as it is now.', schema: OrderView },
      ...standardErrors,
      404: { description: 'No such order item.', schema: ApiError },
      409: { description: 'The kitchen has started it: void it instead.', schema: ApiError },
    },
  },
  {
    operationId: 'voidOrderItem',
    method: 'POST',
    path: '/api/v1/order-items/:orderItemId/void',
    summary: 'Void an item after preparation started, with a reason',
    description:
      "Cashiers and waiters need a manager's PIN (override token, AUTH-011). A station still " +
      'working on it gets a CANCELLED slip (ORD-011, ORD-012). Audited with the approver.',
    tags: ['orders'],
    requirements: ['ORD-011', 'ORD-012', 'AUTH-011', 'AUD-001'],
    capability: 'ITEM_VOID_AFTER_PREP',
    request: { params: OrderItemParams, body: OrderItemEndRequest },
    responses: {
      200: { description: 'The order as it is now.', schema: OrderView },
      ...standardErrors,
      404: { description: 'No such order item.', schema: ApiError },
      409: { description: 'The item has not been started: cancel it instead.', schema: ApiError },
    },
  },
  {
    operationId: 'modifyOrderItem',
    method: 'PATCH',
    path: '/api/v1/order-items/:orderItemId',
    summary: 'Change the quantity or instructions of an item the kitchen has not started',
    description:
      'The station gets a MODIFIED ticket with the new quantity and instructions; nothing changes ' +
      'silently (ORD-012). Stock follows the quantity. Combos are cancelled and ordered again ' +
      'instead. Audited.',
    tags: ['orders'],
    requirements: ['ORD-012', 'ORD-015', 'AUD-001'],
    capability: 'ORDER_CREATE',
    request: { params: OrderItemParams, body: ModifyOrderItemRequest },
    responses: {
      200: { description: 'The order as it is now.', schema: OrderView },
      ...standardErrors,
      404: { description: 'No such order item.', schema: ApiError },
      409: {
        description: 'The kitchen has started it, it is a combo, or stock ran out.',
        schema: ApiError,
      },
      422: { description: 'The instructions are too long.', schema: ApiError },
    },
  },
  {
    operationId: 'listStations',
    method: 'GET',
    path: '/api/v1/stations',
    summary: 'Kitchen stations with their mode and printer, archived ones included',
    tags: ['printing'],
    requirements: ['KDS-002', 'KDS-008'],
    capability: 'SESSION',
    responses: {
      200: { description: 'Stations.', schema: StationListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createStation',
    method: 'POST',
    path: '/api/v1/stations',
    summary: 'Add a station',
    description: 'Managers and the Owner (BRD §4.2 "configure printers, stations"). Audited.',
    tags: ['printing'],
    requirements: ['KDS-002', 'KDS-008', 'ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { body: StationRequest },
    responses: {
      201: { description: 'The new station.', schema: StationView },
      ...standardErrors,
      409: { description: 'Another active station has that name.', schema: ApiError },
      422: { description: 'The printer is unknown or archived.', schema: ApiError },
    },
  },
  {
    operationId: 'updateStation',
    method: 'PUT',
    path: '/api/v1/stations/:id',
    summary: 'Change a station',
    tags: ['printing'],
    requirements: ['KDS-002', 'KDS-008', 'ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: PrintingParams, body: StationRequest },
    responses: {
      200: { description: 'The station as it is now.', schema: StationView },
      ...standardErrors,
      404: { description: 'No such station.', schema: ApiError },
      409: { description: 'Archived, or another active station has that name.', schema: ApiError },
      422: { description: 'The printer is unknown or archived.', schema: ApiError },
    },
  },
  {
    operationId: 'archiveStation',
    method: 'POST',
    path: '/api/v1/stations/:id/archive',
    summary: 'Archive a station nothing uses any more',
    description: 'Active menu items must move to another station first.',
    tags: ['printing'],
    requirements: ['KDS-002', 'KDS-008', 'ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: PrintingParams, body: PrintingArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: StationView },
      ...standardErrors,
      404: { description: 'No such station.', schema: ApiError },
      409: { description: 'Still in use.', schema: ApiError },
    },
  },
  {
    operationId: 'listPrinters',
    method: 'GET',
    path: '/api/v1/printers',
    summary: 'Printers with their connection and last contact, archived ones included',
    tags: ['printing'],
    requirements: ['KDS-008', 'ONB-004'],
    capability: 'OPERATIONS_CONFIGURE',
    responses: {
      200: { description: 'Printers.', schema: PrinterListResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'createPrinter',
    method: 'POST',
    path: '/api/v1/printers',
    summary: 'Add a printer',
    description: 'Managers and the Owner (BRD §4.2 "configure printers, stations"). Audited.',
    tags: ['printing'],
    requirements: ['KDS-008', 'ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { body: PrinterRequest },
    responses: {
      201: { description: 'The new printer.', schema: PrinterView },
      ...standardErrors,
      409: { description: 'Another active printer has that name.', schema: ApiError },
    },
  },
  {
    operationId: 'updatePrinter',
    method: 'PUT',
    path: '/api/v1/printers/:id',
    summary: 'Change a printer',
    tags: ['printing'],
    requirements: ['KDS-008', 'ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: PrintingParams, body: PrinterRequest },
    responses: {
      200: { description: 'The printer as it is now.', schema: PrinterView },
      ...standardErrors,
      404: { description: 'No such printer.', schema: ApiError },
      409: { description: 'Archived, or another active printer has that name.', schema: ApiError },
    },
  },
  {
    operationId: 'archivePrinter',
    method: 'POST',
    path: '/api/v1/printers/:id/archive',
    summary: 'Archive a printer nothing uses any more',
    description: 'Active stations must use another printer first.',
    tags: ['printing'],
    requirements: ['KDS-008', 'ONB-004', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: PrintingParams, body: PrintingArchiveRequest },
    responses: {
      200: { description: 'Archived.', schema: PrinterView },
      ...standardErrors,
      404: { description: 'No such printer.', schema: ApiError },
      409: { description: 'Still in use.', schema: ApiError },
    },
  },
  {
    operationId: 'testPrinter',
    method: 'POST',
    path: '/api/v1/printers/:id/test',
    summary: 'Print a test page',
    description: 'ONB-004 step 6. Answers whether the printer took the page, and why not.',
    tags: ['printing'],
    requirements: ['KDS-008', 'ONB-004'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: PrintingParams },
    responses: {
      200: { description: 'The result.', schema: TestPrintResponse },
      ...standardErrors,
      404: { description: 'No such active printer.', schema: ApiError },
    },
  },
  {
    operationId: 'redirectPrinter',
    method: 'POST',
    path: '/api/v1/printers/:id/redirect',
    summary: "Send a printer's tickets to another printer, or stop doing so",
    description:
      'KDS-008: while a printer is broken, a manager chooses another one; waiting tickets print ' +
      'there. `toPrinterId: null` sends them back. Audited.',
    tags: ['printing'],
    requirements: ['KDS-008', 'AUD-001'],
    capability: 'OPERATIONS_CONFIGURE',
    request: { params: PrintingParams, body: PrinterRedirectRequest },
    responses: {
      200: { description: 'The printer as it is now.', schema: PrinterView },
      ...standardErrors,
      404: { description: 'No such active printer.', schema: ApiError },
      422: {
        description: 'The target is this printer, archived, or itself redirected.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'getPrintQueue',
    method: 'GET',
    path: '/api/v1/print-queue',
    summary: 'Printers with their state and waiting tickets',
    description: 'For the POS and manager "printer offline" alert (KDS-008, NTF-003).',
    tags: ['printing'],
    requirements: ['KDS-008', 'NTF-003'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    responses: {
      200: { description: 'The queue.', schema: PrintQueueResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'reprintKot',
    method: 'POST',
    path: '/api/v1/kots/:id/reprint',
    summary: 'Print a kitchen ticket again',
    description:
      "KDS-008. Prints now on the station's printer (following a redirect) or on the printer " +
      'chosen, marked REPRINT. Answers whether it printed. Audited.',
    tags: ['printing'],
    requirements: ['KDS-008', 'AUD-001'],
    capability: 'ORDER_CREATE',
    request: { params: KotParams, body: KotReprintRequest },
    responses: {
      200: { description: 'The result.', schema: TestPrintResponse },
      ...standardErrors,
      404: { description: 'No such ticket.', schema: ApiError },
      422: { description: 'No printer to print on.', schema: ApiError },
    },
  },
  {
    operationId: 'openBill',
    method: 'POST',
    path: '/api/v1/bills',
    summary: 'Open the bill of a table session or a takeaway order (or return the open one)',
    description:
      'BILL-001. The bill is priced on the server from what was ordered, with the restaurant’s ' +
      'price mode, tax groups, rounding and service charge settings.',
    tags: ['billing'],
    requirements: ['BILL-001', 'BILL-004'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { body: OpenBillRequest },
    responses: {
      200: { description: 'The bill as it stands.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such open table session or takeaway order.', schema: ApiError },
    },
  },
  {
    operationId: 'getBill',
    method: 'GET',
    path: '/api/v1/bills/:id',
    summary: 'The bill as it stands',
    tags: ['billing'],
    requirements: ['BILL-001'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: BillParams },
    responses: {
      200: { description: 'The bill.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such bill.', schema: ApiError },
    },
  },
  {
    operationId: 'addBillDiscount',
    method: 'POST',
    path: '/api/v1/bills/:id/discounts',
    summary: 'Give an item or bill discount, or make an item complimentary',
    description:
      'BILL-005. A reason is required. Above the cashier’s limit, or complimentary, a manager’s ' +
      'override token for DISCOUNT_ABOVE_LIMIT goes in `x-override-token`. Audited.',
    tags: ['billing'],
    requirements: ['BILL-005', 'AUTH-011', 'AUD-001'],
    capability: 'DISCOUNT_WITHIN_LIMIT',
    request: { params: BillParams, body: DiscountRequest },
    responses: {
      200: { description: 'The bill with the discount.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such bill or item on it.', schema: ApiError },
      409: {
        description: 'The bill is printed, or already has a discount of that kind.',
        schema: ApiError,
      },
      422: { description: 'The discount is larger than what it applies to.', schema: ApiError },
    },
  },
  {
    operationId: 'revokeBillDiscount',
    method: 'POST',
    path: '/api/v1/bills/:id/discounts/:discountId/revoke',
    summary: 'Take a discount back before the bill is printed',
    tags: ['billing'],
    requirements: ['BILL-005', 'AUD-001'],
    capability: 'DISCOUNT_WITHIN_LIMIT',
    request: { params: BillDiscountParams, body: RevokeDiscountRequest },
    responses: {
      200: { description: 'The bill without it.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such discount on this bill.', schema: ApiError },
      409: { description: 'The bill is printed.', schema: ApiError },
    },
  },
  {
    operationId: 'setBillServiceCharge',
    method: 'POST',
    path: '/api/v1/bills/:id/service-charge',
    summary: 'Remove the voluntary service charge at the diner’s request, or restore it',
    tags: ['billing'],
    requirements: ['BILL-006', 'AUD-001'],
    capability: 'SERVICE_CHARGE_REMOVE',
    request: { params: BillParams, body: ServiceChargeRequest },
    responses: {
      200: { description: 'The bill.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such bill.', schema: ApiError },
      409: { description: 'The bill is printed.', schema: ApiError },
    },
  },
  {
    operationId: 'setBillCustomer',
    method: 'PUT',
    path: '/api/v1/bills/:id/customer',
    summary: 'Record the customer’s name, phone (with consent) and GSTIN for the invoice',
    tags: ['billing'],
    requirements: ['BILL-011', 'BILL-002'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: BillParams, body: BillCustomerRequest },
    responses: {
      200: { description: 'The bill.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such bill.', schema: ApiError },
      409: { description: 'The bill is printed.', schema: ApiError },
    },
  },
  {
    operationId: 'issueInvoice',
    method: 'POST',
    path: '/api/v1/bills/:id/invoice',
    summary: 'Print the bill: issue its GST invoice with the next number',
    description:
      'BILL-002, BILL-003. The number comes from the series with no gaps; the lines, taxes and ' +
      'particulars are kept as issued. The table moves to Bill printed. Audited.',
    tags: ['billing'],
    requirements: ['BILL-002', 'BILL-003', 'BILL-001', 'AUD-001'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: BillParams, body: IssueInvoiceRequest },
    responses: {
      201: { description: 'The invoice.', schema: InvoiceView },
      ...standardErrors,
      404: { description: 'No such bill.', schema: ApiError },
      409: {
        description: 'Already printed, nothing to bill, or items still waiting for approval.',
        schema: ApiError,
      },
      422: { description: 'The series is unknown, archived or full.', schema: ApiError },
    },
  },
  {
    operationId: 'getInvoice',
    method: 'GET',
    path: '/api/v1/invoices/:id',
    summary: 'An invoice as issued, for the on-screen preview',
    tags: ['billing'],
    requirements: ['BILL-002', 'BILL-014'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: InvoiceParams },
    responses: {
      200: { description: 'The invoice.', schema: InvoiceView },
      ...standardErrors,
      404: { description: 'No such invoice.', schema: ApiError },
    },
  },
  {
    operationId: 'printInvoice',
    method: 'POST',
    path: '/api/v1/invoices/:id/print',
    summary: 'Print an invoice on the bill printer; later prints are marked DUPLICATE',
    description:
      'BILL-014, BILL-009. The first successful print is the original; every later one is ' +
      'marked DUPLICATE and audited. Answers whether it printed.',
    tags: ['billing'],
    requirements: ['BILL-014', 'BILL-009', 'AUD-001'],
    capability: 'BILL_REPRINT',
    request: { params: InvoiceParams, body: PrintInvoiceRequest },
    responses: {
      200: { description: 'The result.', schema: PrintInvoiceResponse },
      ...standardErrors,
      404: { description: 'No such invoice.', schema: ApiError },
      409: { description: 'The invoice is voided.', schema: ApiError },
      422: { description: 'No bill printer is set, or the printer is unknown.', schema: ApiError },
    },
  },
  {
    operationId: 'voidInvoice',
    method: 'POST',
    path: '/api/v1/invoices/:id/void',
    summary: 'Void an invoice so the bill can be corrected and issued again',
    description:
      'BILL-010, BILL-003. The invoice keeps its number with status VOIDED; the bill opens again ' +
      'and its next invoice gets a new number and points back at this one. Cashiers need a ' +
      'manager’s override token. Audited with the approver.',
    tags: ['billing'],
    requirements: ['BILL-010', 'BILL-003', 'AUTH-011', 'AUD-001'],
    capability: 'INVOICE_VOID',
    request: { params: InvoiceParams, body: VoidInvoiceRequest },
    responses: {
      200: { description: 'The voided invoice.', schema: InvoiceView },
      ...standardErrors,
      404: { description: 'No such invoice.', schema: ApiError },
      409: { description: 'Already voided, or its bill has a newer invoice.', schema: ApiError },
    },
  },
  {
    operationId: 'reopenInvoice',
    method: 'POST',
    path: '/api/v1/invoices/:id/reopen',
    summary: 'Reopen a printed bill to edit its items or discounts',
    description:
      'BILL-010. Only an issued, unsettled invoice. The bill opens again; issuing it updates the ' +
      'same invoice under the same number, audited with the reason, the approver and the values ' +
      'before and after. Cashiers need a manager’s override token.',
    tags: ['billing'],
    requirements: ['BILL-010', 'AUTH-011', 'AUD-001'],
    capability: 'BILL_EDIT_AFTER_PRINT',
    request: { params: InvoiceParams, body: ReopenInvoiceRequest },
    responses: {
      200: { description: 'The bill, open for editing.', schema: BillView },
      ...standardErrors,
      404: { description: 'No such invoice.', schema: ApiError },
      409: {
        description: 'Settled (void and re-issue it instead), voided, or already reopened.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'splitBill',
    method: 'POST',
    path: '/api/v1/bills/:id/split',
    summary: 'Split a bill by items or into equal parts, each with its own invoice number',
    description:
      'BILL-007. Every amount of the parts (lines, discounts, each tax, service charge and ' +
      'round-off) adds up exactly to the whole bill. Audited.',
    tags: ['billing'],
    requirements: ['BILL-007', 'BILL-003', 'AUD-001'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: BillParams, body: SplitBillRequest },
    responses: {
      201: { description: 'The invoices, one per part.', schema: SplitBillResponse },
      ...standardErrors,
      404: { description: 'No such bill.', schema: ApiError },
      409: {
        description: 'Already printed, being edited, nothing to bill, or items awaiting approval.',
        schema: ApiError,
      },
      422: {
        description: 'The parts do not give out every item exactly, or the series is unusable.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'openShift',
    method: 'POST',
    path: '/api/v1/shifts',
    summary: 'Open a cash shift with an opening float',
    description: 'BILL-013. One open shift per person. Audited.',
    tags: ['payments'],
    requirements: ['BILL-013', 'AUD-001'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { body: OpenShiftRequest },
    responses: {
      201: { description: 'The shift.', schema: ShiftView },
      ...standardErrors,
      409: { description: 'This person already has an open shift.', schema: ApiError },
    },
  },
  {
    operationId: 'getCurrentShift',
    method: 'GET',
    path: '/api/v1/shifts/current',
    summary: 'The signed-in person’s open shift, with the cash expected in the drawer',
    tags: ['payments'],
    requirements: ['BILL-013'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    responses: {
      200: { description: 'The shift, or null.', schema: CurrentShiftResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'recordCashMovement',
    method: 'POST',
    path: '/api/v1/shifts/:id/cash-movements',
    summary: 'Record cash taken into or out of the drawer, with a reason',
    description: 'BILL-013. Cashiers for their own shift; managers for any. Audited.',
    tags: ['payments'],
    requirements: ['BILL-013', 'AUD-001'],
    capability: 'CASH_MOVEMENT_AND_SHIFT_CLOSE',
    request: { params: ShiftParams, body: CashMovementRequest },
    responses: {
      200: { description: 'The shift.', schema: ShiftView },
      ...standardErrors,
      404: { description: 'No such shift.', schema: ApiError },
      409: { description: 'The shift is closed.', schema: ApiError },
    },
  },
  {
    operationId: 'closeShift',
    method: 'POST',
    path: '/api/v1/shifts/:id/close',
    summary: 'Close a shift: counted cash against expected, and the variance',
    description:
      'BILL-013, AUD-006. The expected cash is the float plus cash payments plus cash in minus ' +
      'cash out. Cashiers for their own shift; managers for any. Audited.',
    tags: ['payments'],
    requirements: ['BILL-013', 'AUD-006', 'AUD-001'],
    capability: 'CASH_MOVEMENT_AND_SHIFT_CLOSE',
    request: { params: ShiftParams, body: CloseShiftRequest },
    responses: {
      200: { description: 'The closed shift.', schema: ShiftView },
      ...standardErrors,
      404: { description: 'No such shift.', schema: ApiError },
      409: { description: 'Already closed.', schema: ApiError },
    },
  },
  {
    operationId: 'recordPayments',
    method: 'POST',
    path: '/api/v1/invoices/:id/payments',
    summary: 'Record payments against an invoice; settled when they equal the total',
    description:
      'BILL-008. Split across modes and paid in steps, never more than the total. Cash needs ' +
      'an open shift. When a table’s last bill is paid, the table is freed. Idempotent. Audited.',
    tags: ['payments'],
    requirements: ['BILL-008', 'BILL-013', 'TBL-004', 'AUD-001'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: InvoiceParams, body: RecordPaymentsRequest },
    responses: {
      200: { description: 'The invoice’s payments.', schema: InvoicePaymentsView },
      ...standardErrors,
      404: { description: 'No such invoice.', schema: ApiError },
      409: {
        description: 'Voided or already settled, or cash without an open shift.',
        schema: ApiError,
      },
      422: { description: 'More than the bill, or cash tendered short.', schema: ApiError },
    },
  },
  {
    operationId: 'getInvoicePayments',
    method: 'GET',
    path: '/api/v1/invoices/:id/payments',
    summary: 'The payments of an invoice and what remains to pay',
    tags: ['payments'],
    requirements: ['BILL-008'],
    capability: 'BILL_PRINT_AND_PAYMENT',
    request: { params: InvoiceParams },
    responses: {
      200: { description: 'The payments.', schema: InvoicePaymentsView },
      ...standardErrors,
      404: { description: 'No such invoice.', schema: ApiError },
    },
  },
  {
    operationId: 'previewDayEnd',
    method: 'GET',
    path: '/api/v1/day-end',
    summary: 'The current business date’s Z-report and what blocks closing it',
    tags: ['day-end'],
    requirements: ['BILL-013', 'RPT-005'],
    capability: 'DAY_END_CLOSE',
    responses: {
      200: { description: 'The preview.', schema: DayEndPreview },
      ...standardErrors,
    },
  },
  {
    operationId: 'closeDay',
    method: 'POST',
    path: '/api/v1/day-end',
    summary: 'Close the business date and keep its Z-report',
    description:
      'BILL-013. Refused while shifts are open or takeaway bills are unpaid; open tables block ' +
      'unless carried forward to the next business date. Afterwards everything recorded belongs ' +
      'to the next business date. Audited.',
    tags: ['day-end'],
    requirements: ['BILL-013', 'RPT-005', 'AUD-001'],
    capability: 'DAY_END_CLOSE',
    request: { body: CloseDayRequest },
    responses: {
      201: { description: 'The closed day and its Z-report.', schema: DayEndView },
      ...standardErrors,
      409: {
        description:
          'Blocked (details list the blockers), already closed, or not the current date.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'getDayEnd',
    method: 'GET',
    path: '/api/v1/day-ends/:businessDate',
    summary: 'The Z-report kept when a business date was closed',
    tags: ['day-end'],
    requirements: ['RPT-005'],
    capability: 'DAY_END_CLOSE',
    request: { params: DayEndParams },
    responses: {
      200: { description: 'The closed day.', schema: DayEndView },
      ...standardErrors,
      404: { description: 'That date is not closed.', schema: ApiError },
    },
  },
  {
    operationId: 'getSalesSummary',
    method: 'GET',
    path: '/api/v1/reports/sales',
    summary: 'Sales by business date and by hour',
    tags: ['reports'],
    requirements: ['RPT-001'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { query: ReportRangeQuery },
    responses: {
      200: { description: 'The report.', schema: SalesSummaryResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getItemSales',
    method: 'GET',
    path: '/api/v1/reports/items',
    summary: 'Item-wise and category-wise sales',
    tags: ['reports'],
    requirements: ['RPT-002'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { query: ReportRangeQuery },
    responses: {
      200: { description: 'The report.', schema: ItemSalesResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getPaymentModes',
    method: 'GET',
    path: '/api/v1/reports/payments',
    summary: 'Payments per mode',
    tags: ['reports'],
    requirements: ['RPT-005'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { query: ReportRangeQuery },
    responses: {
      200: { description: 'The report.', schema: PaymentModesResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getShiftReport',
    method: 'GET',
    path: '/api/v1/reports/shifts',
    summary: 'Shifts with cash and variance (cashiers: their own)',
    tags: ['reports'],
    requirements: ['RPT-005'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { query: ReportRangeQuery },
    responses: {
      200: { description: 'The report.', schema: ShiftReportResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getGstSummary',
    method: 'GET',
    path: '/api/v1/reports/gst',
    summary: 'GST summary: taxable value and tax by SAC and rate',
    tags: ['reports'],
    requirements: ['RPT-006'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { query: ReportRangeQuery },
    responses: {
      200: { description: 'The report.', schema: GstSummaryResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getInvoiceRegister',
    method: 'GET',
    path: '/api/v1/reports/invoice-register',
    summary: 'Every invoice number in sequence, cancelled ones included (by invoice date)',
    tags: ['reports'],
    requirements: ['RPT-006'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { query: ReportRangeQuery },
    responses: {
      200: { description: 'The report.', schema: InvoiceRegisterResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'exportReport',
    method: 'POST',
    path: '/api/v1/reports/exports',
    summary: 'Export a report as CSV, stamped and audited',
    description:
      'The file starts with the restaurant, the report, its filters, who generated it and when ' +
      '(RPT-017); every export is audited as REPORT_EXPORTED. Cashiers may export their own shift ' +
      'report only. Amounts are plain rupees with two decimals.',
    tags: ['reports'],
    requirements: ['RPT-017', 'AUD-001'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { body: ReportExportRequest },
    responses: {
      200: { description: 'The exported file.', schema: ReportExportResponse },
      ...standardErrors,
    },
  },
  {
    operationId: 'getOrderDrillDown',
    method: 'GET',
    path: '/api/v1/reports/orders/:orderId',
    summary: 'Everything about one order and who did each step',
    tags: ['reports'],
    requirements: ['RPT-015'],
    capability: 'REPORTS_VIEW_EXPORT',
    request: { params: OrderDrillDownParams },
    responses: {
      200: { description: 'The order and its history.', schema: OrderDrillDownResponse },
      ...standardErrors,
      404: { description: 'No such order.', schema: ApiError },
    },
  },
] as const satisfies readonly RouteDefinition[];
