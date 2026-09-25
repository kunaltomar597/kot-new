import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DEVICE_AUTHENTICATOR, type DeviceAuthenticator } from './device.js';
import type { AuthenticatedRequest } from './principal.js';
import { SessionService } from './session.service.js';

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

/** The token of an `Authorization: Bearer` header; empty when missing or malformed. */
function bearerToken(header: string | undefined): string {
  return BEARER.exec(header ?? '')?.[1] ?? '';
}

/**
 * Works out who is calling, before any route runs: the paired device from its device credential
 * (P0-11) and the signed-in person from the access token (AUTH-005). It never rejects a request
 * itself; the permission guard does, using what was found here (including why a token failed).
 */
@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
  constructor(
    @Inject(DEVICE_AUTHENTICATOR) private readonly devices: DeviceAuthenticator,
    private readonly sessions: SessionService,
  ) {}

  async use(request: Request, _response: Response, next: NextFunction): Promise<void> {
    try {
      const target = request as AuthenticatedRequest;
      // Both checks always run; what the request carries only decides what they conclude, never
      // whether they run (CWE-807).
      const device = await this.devices.authenticate(request);
      const token = bearerToken(request.headers.authorization);
      const result = await this.sessions.authenticate(token, device);
      target.device = device;
      if ('principal' in result) target.principal = result.principal;
      // Without a bearer token, a protected route simply answers "please sign in".
      else if (token !== '') target.authFailure = result.failure;
      next();
    } catch (error) {
      next(error);
    }
  }
}
