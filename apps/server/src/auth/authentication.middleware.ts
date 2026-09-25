import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DEVICE_AUTHENTICATOR, type DeviceAuthenticator } from './device.js';
import type { AuthenticatedRequest } from './principal.js';
import { SessionService } from './session.service.js';

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

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
      const device = await this.devices.authenticate(request);
      if (device !== undefined) target.device = device;
      const header = request.headers.authorization;
      if (header !== undefined) {
        const token = BEARER.exec(header)?.[1];
        const result =
          token === undefined ? undefined : await this.sessions.authenticate(token, device);
        if (result !== undefined && 'principal' in result) target.principal = result.principal;
        else target.authFailure = result?.failure;
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}
