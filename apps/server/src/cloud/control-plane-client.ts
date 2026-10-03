import { createHash, randomBytes, sign } from 'node:crypto';
import { ApiError } from '@rp/contracts';
import {
  CloudBackupView,
  type CompleteCloudBackupRequest,
  type EscrowBackupKeyRequest,
  type StartCloudBackupRequest,
  StartCloudBackupResponse,
  type DeclineDiagnosticsRequest,
  type DiagnosticsUploadRequest,
  DiagnosticsUploadResponse,
  CONTROL_PLANE_ERRORS,
  EnrolResponse,
  enrolmentProofMessage,
  type HeartbeatRequest,
  HeartbeatResponse,
  INSTALLATION_HEADERS,
  type MenuExtractionRequest,
  MenuExtractionView,
  signedRequestMessage,
  UpdatesResponse,
} from '@rp/contracts/control-plane';
import { z } from 'zod';
import type { InstallationKey } from './installation-key.js';

const DEFAULT_TIMEOUT_MS = 15_000;
/** Up to 20 MB of menu photos over a restaurant's connection. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** A failed call to the Control Plane; `code` is its `ApiError.code` or `UNREACHABLE`. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export interface ControlPlaneClientOptions {
  /** Origin of the Control Plane, e.g. `https://control-plane.example.com`. */
  readonly baseUrl: string;
  readonly key: InstallationKey;
  readonly fetch?: typeof fetch;
  /** This PC's clock; the client corrects it by `clockOffsetMs`. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * The local server's client of the Vendor Control Plane (ADR-0012): enrolment, then requests
 * signed with the installation key. Outbound HTTPS only (ADR-0004); redirects are refused.
 */
export class ControlPlaneClient {
  /** How far this PC's clock is behind the Control Plane's, learnt from `CLOCK_SKEW` answers. */
  clockOffsetMs = 0;

  constructor(private readonly options: ControlPlaneClientOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Registers this PC's public key with a one-time code from the vendor. */
  enrol(code: string): Promise<EnrolResponse> {
    const { key } = this.options;
    const body = JSON.stringify({
      code,
      publicKey: key.publicKeySpki,
      proof: sign(null, Buffer.from(enrolmentProofMessage(code), 'utf8'), key.privateKey).toString(
        'base64',
      ),
    });
    return this.send('POST', '/v1/enrolments', body, {}, EnrolResponse);
  }

  heartbeat(installationId: string, heartbeat: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.signed(
      installationId,
      'POST',
      '/v1/heartbeats',
      JSON.stringify(heartbeat),
      HeartbeatResponse,
    );
  }

  updates(installationId: string, version: string): Promise<UpdatesResponse> {
    const path = `/v1/updates?version=${encodeURIComponent(version)}`;
    return this.signed(installationId, 'GET', path, undefined, UpdatesResponse);
  }

  /** ONB-006: photos or PDFs of the printed menu, to be read by the AI provider (P6-04). */
  createMenuExtraction(
    installationId: string,
    request: MenuExtractionRequest,
  ): Promise<MenuExtractionView> {
    return this.signed(
      installationId,
      'POST',
      '/v1/menu-extractions',
      JSON.stringify(request),
      MenuExtractionView,
      UPLOAD_TIMEOUT_MS,
    );
  }

  /** UPD-008: a diagnostics bundle the manager allowed to send (P7-08a). */
  uploadDiagnostics(
    installationId: string,
    upload: DiagnosticsUploadRequest,
  ): Promise<DiagnosticsUploadResponse> {
    return this.signed(
      installationId,
      'POST',
      '/v1/diagnostics',
      JSON.stringify(upload),
      DiagnosticsUploadResponse,
      UPLOAD_TIMEOUT_MS,
    );
  }

  /** UPD-008: the manager declined support's request (P7-08b). */
  async declineDiagnosticsRequest(
    installationId: string,
    requestId: string,
    body: DeclineDiagnosticsRequest,
  ): Promise<void> {
    await this.signed(
      installationId,
      'POST',
      `/v1/diagnostics-requests/${encodeURIComponent(requestId)}/decline`,
      JSON.stringify(body),
      z.undefined(),
    );
  }

  /** DATA-003: where to put the night's encrypted backup, part by part (P7-05d). */
  startCloudBackup(
    installationId: string,
    request: StartCloudBackupRequest,
  ): Promise<StartCloudBackupResponse> {
    return this.signed(
      installationId,
      'POST',
      '/v1/cloud-backups',
      JSON.stringify(request),
      StartCloudBackupResponse,
    );
  }

  completeCloudBackup(
    installationId: string,
    id: string,
    request: CompleteCloudBackupRequest,
  ): Promise<CloudBackupView> {
    return this.signed(
      installationId,
      'POST',
      `/v1/cloud-backups/${encodeURIComponent(id)}/complete`,
      JSON.stringify(request),
      CloudBackupView,
      UPLOAD_TIMEOUT_MS,
    );
  }

  async abortCloudBackup(installationId: string, id: string): Promise<void> {
    await this.signed(
      installationId,
      'POST',
      `/v1/cloud-backups/${encodeURIComponent(id)}/abort`,
      undefined,
      z.undefined(),
    );
  }

  /** DATA-003, OI-10: the backup key, wrapped with the vendor's escrow key (P7-05e). */
  async escrowBackupKey(installationId: string, request: EscrowBackupKeyRequest): Promise<void> {
    await this.signed(
      installationId,
      'PUT',
      '/v1/backup-key-escrow',
      JSON.stringify(request),
      z.undefined(),
    );
  }

  /** A part URL the Control Plane gave, absolute (S3) or on its own address (development). */
  resolveUrl(url: string): string {
    return new URL(url, `${this.options.baseUrl}/`).toString();
  }

  getMenuExtraction(installationId: string, extractionId: string): Promise<MenuExtractionView> {
    return this.signed(
      installationId,
      'GET',
      `/v1/menu-extractions/${encodeURIComponent(extractionId)}`,
      undefined,
      MenuExtractionView,
    );
  }

  /** A signed request; after `CLOCK_SKEW` it corrects the clock offset and tries once more. */
  private async signed<S extends z.ZodType>(
    installationId: string,
    method: string,
    path: string,
    body: string | undefined,
    schema: S,
    timeoutMs?: number,
  ): Promise<z.output<S>> {
    try {
      return await this.send(
        method,
        path,
        body,
        this.headers(installationId, method, path, body),
        schema,
        timeoutMs,
      );
    } catch (error) {
      const serverTime =
        error instanceof ControlPlaneError && error.code === CONTROL_PLANE_ERRORS.clockSkew
          ? Date.parse(String(error.details?.serverTime))
          : Number.NaN;
      if (Number.isNaN(serverTime)) throw error;
      this.clockOffsetMs = serverTime - this.now();
      return this.send(
        method,
        path,
        body,
        this.headers(installationId, method, path, body),
        schema,
        timeoutMs,
      );
    }
  }

  private headers(
    installationId: string,
    method: string,
    path: string,
    body: string | undefined,
  ): Record<string, string> {
    const timestamp = String(Math.round(this.now() + this.clockOffsetMs));
    const nonce = randomBytes(16).toString('base64url');
    const message = signedRequestMessage({
      method,
      path,
      timestamp,
      nonce,
      bodySha256: createHash('sha256')
        .update(body ?? '', 'utf8')
        .digest('hex'),
    });
    return {
      [INSTALLATION_HEADERS.installation]: installationId,
      [INSTALLATION_HEADERS.timestamp]: timestamp,
      [INSTALLATION_HEADERS.nonce]: nonce,
      [INSTALLATION_HEADERS.signature]: sign(
        null,
        Buffer.from(message, 'utf8'),
        this.options.key.privateKey,
      ).toString('base64'),
    };
  }

  private async send<S extends z.ZodType>(
    method: string,
    path: string,
    body: string | undefined,
    headers: Record<string, string>,
    schema: S,
    timeoutMs?: number,
  ): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body !== undefined && { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ControlPlaneError(
        undefined,
        'UNREACHABLE',
        `The Control Plane could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const error = ApiError.safeParse(json);
      throw error.success
        ? new ControlPlaneError(
            response.status,
            error.data.code,
            error.data.message,
            error.data.details,
          )
        : new ControlPlaneError(
            response.status,
            `HTTP_${String(response.status)}`,
            `The Control Plane answered ${String(response.status)}.`,
          );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ControlPlaneError(
        response.status,
        'INVALID_RESPONSE',
        'The Control Plane answered in an unexpected format.',
      );
    }
    return parsed.data;
  }
}
