import { ApiError } from '../common.js';
import type { RouteDefinition, RouteResponse } from '../routes.js';
import { HealthResponse } from '../system.js';
import {
  EnrolRequest,
  EnrolResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  UpdatesQuery,
  UpdatesResponse,
} from './schemas.js';

/**
 * Who may call a Control Plane endpoint: `INSTALLATION` needs a request signed by an enrolled
 * installation (ADR-0012); `PUBLIC` endpoints need no credential and say why. Vendor staff use
 * the admin CLI until the web app (VCP-001, P7-02).
 */
export type ControlPlaneAccess = 'INSTALLATION' | 'PUBLIC';

/** Errors of every signed endpoint. */
const signedErrors = {
  400: { description: 'The request does not match the contract.', schema: ApiError },
  401: {
    description:
      'Missing or invalid signature, unknown installation, reused nonce, or a clock outside the ' +
      'window (`CLOCK_SKEW`, with `details.serverTime`).',
    schema: ApiError,
  },
  403: { description: 'The vendor revoked this installation.', schema: ApiError },
} as const satisfies Readonly<Record<number, RouteResponse>>;

/** REST route registry of the Vendor Control Plane (ADR-0012), documented like the local API. */
export const CONTROL_PLANE_ROUTES = [
  {
    operationId: 'getControlPlaneHealth',
    method: 'GET',
    path: '/v1/health',
    summary: 'Liveness and database status',
    description:
      'Public because the load balancer and uptime monitoring call it; it reveals nothing but ' +
      'whether the service and its database answer.',
    tags: ['system'],
    requirements: ['VCP-009'],
    capability: 'PUBLIC',
    responses: {
      200: { description: 'Service and database are up.', schema: HealthResponse },
      503: { description: 'The database is down.', schema: HealthResponse },
    },
  },
  {
    operationId: 'enrolInstallation',
    method: 'POST',
    path: '/v1/enrolments',
    summary: 'Register a restaurant PC with a one-time enrolment code',
    description:
      'Public because the installation has no credential yet: the one-time code and the proof ' +
      'that it holds the private key are its credential. Codes are used once and expire; attempts ' +
      'are rate-limited per client address.',
    tags: ['installations'],
    requirements: ['SEC-002', 'ONB-003'],
    capability: 'PUBLIC',
    request: { body: EnrolRequest },
    responses: {
      201: { description: 'Enrolled.', schema: EnrolResponse },
      400: signedErrors[400],
      401: { description: 'Unknown, used or expired code, or a bad proof.', schema: ApiError },
      429: { description: 'Too many attempts from this address.', schema: ApiError },
    },
  },
  {
    operationId: 'postHeartbeat',
    method: 'POST',
    path: '/v1/heartbeats',
    summary: 'Report that an installation is alive, with its versions and health',
    description:
      'Every 5 minutes by default; the answer sets the next interval, gives the server time and ' +
      'offers the release to update to. Sending the same heartbeat again is harmless.',
    tags: ['installations'],
    requirements: ['VCP-005', 'NFR-O03', 'UPD-002', 'UPD-010', 'LIC-007'],
    capability: 'INSTALLATION',
    request: { body: HeartbeatRequest },
    responses: {
      200: { description: 'Recorded.', schema: HeartbeatResponse },
      ...signedErrors,
    },
  },
  {
    operationId: 'getUpdates',
    method: 'GET',
    path: '/v1/updates',
    summary: 'The release an installation should move to from a given version',
    tags: ['releases'],
    requirements: ['UPD-002', 'UPD-007'],
    capability: 'INSTALLATION',
    request: { query: UpdatesQuery },
    responses: {
      200: { description: 'The update, or null when up to date.', schema: UpdatesResponse },
      ...signedErrors,
    },
  },
] as const satisfies readonly RouteDefinition<ControlPlaneAccess>[];

export type ControlPlaneOperationId = (typeof CONTROL_PLANE_ROUTES)[number]['operationId'];
