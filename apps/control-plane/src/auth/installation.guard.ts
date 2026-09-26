import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CONTROL_PLANE_ERRORS,
  INSTALLATION_HEADERS,
  NONCE_PATTERN,
  type ReleaseChannel,
  SIGNED_REQUEST_WINDOW_MS,
  signedRequestMessage,
} from '@rp/contracts/control-plane';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import { ed25519PublicKey, sha256Hex, verifyEd25519 } from './ed25519.js';
import { NonceStore } from './nonce-store.js';
import { PUBLIC_ROUTE } from './public.decorator.js';

/** The installation a signed request came from. */
export interface AuthenticatedInstallation {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: ReleaseChannel;
}

export type InstallationRequest = Request & {
  installation?: AuthenticatedInstallation;
  /** The exact body bytes (captured by the JSON parser), for the body digest. */
  rawBody?: Buffer;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{1,16}$/;
const MAX_SIGNATURE_LENGTH = 200;

function signatureInvalid(): CpError {
  return new CpError(
    401,
    CONTROL_PLANE_ERRORS.signatureInvalid,
    'The request is not signed by an enrolled installation.',
  );
}

function headerOf(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The authenticated installation of a request that passed the guard. */
export function installationOf(request: InstallationRequest): AuthenticatedInstallation {
  if (request.installation === undefined) throw signatureInvalid();
  return request.installation;
}

/**
 * Checks every request that is not `@Public()`: signed by an enrolled, active installation, within
 * the time window, with a nonce not used before (ADR-0012, SEC-002, SEC-003).
 */
@Injectable()
export class InstallationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly nonces: NonceStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<InstallationRequest>();
    request.installation = await this.authenticate(request);
    return true;
  }

  private async authenticate(request: InstallationRequest): Promise<AuthenticatedInstallation> {
    const installationId = headerOf(request, INSTALLATION_HEADERS.installation);
    const timestamp = headerOf(request, INSTALLATION_HEADERS.timestamp);
    const nonce = headerOf(request, INSTALLATION_HEADERS.nonce);
    const signature = headerOf(request, INSTALLATION_HEADERS.signature);
    if (
      installationId === undefined ||
      !UUID.test(installationId) ||
      timestamp === undefined ||
      !TIMESTAMP.test(timestamp) ||
      nonce === undefined ||
      !NONCE_PATTERN.test(nonce) ||
      signature === undefined ||
      signature.length > MAX_SIGNATURE_LENGTH
    ) {
      throw signatureInvalid();
    }

    const now = Date.now();
    const sentAt = Number(timestamp);
    if (Math.abs(now - sentAt) > SIGNED_REQUEST_WINDOW_MS) {
      throw new CpError(
        401,
        CONTROL_PLANE_ERRORS.clockSkew,
        'The request time is too far from the Control Plane clock; correct the offset and retry.',
        { serverTime: new Date(now).toISOString() },
      );
    }

    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      select: { id: true, tenantId: true, status: true, channel: true, publicKey: true },
    });
    const key =
      installation?.publicKey === null || installation?.publicKey === undefined
        ? undefined
        : ed25519PublicKey(installation.publicKey);
    const message = signedRequestMessage({
      method: request.method,
      path: request.originalUrl,
      timestamp,
      nonce,
      bodySha256: sha256Hex(request.rawBody ?? Buffer.alloc(0)),
    });
    if (installation === null || key === undefined || !verifyEd25519(key, message, signature)) {
      throw signatureInvalid();
    }
    if (installation.status === 'REVOKED') {
      throw new CpError(
        403,
        CONTROL_PLANE_ERRORS.installationRevoked,
        'The vendor disconnected this installation. Contact support to connect it again.',
      );
    }
    if (installation.status !== 'ACTIVE') throw signatureInvalid();

    // Remember the nonce as long as a request with this timestamp could be accepted.
    const fresh = await this.nonces.use(
      installation.id,
      nonce,
      new Date(sentAt + SIGNED_REQUEST_WINDOW_MS),
    );
    if (!fresh) {
      throw new CpError(
        401,
        CONTROL_PLANE_ERRORS.nonceReused,
        'This request was already received; send a new one with a fresh nonce.',
      );
    }
    return { id: installation.id, tenantId: installation.tenantId, channel: installation.channel };
  }
}
