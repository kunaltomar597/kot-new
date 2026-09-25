import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { CAPABILITIES } from '@rp/domain';
import { RequireCapability, RequireSession } from '../../src/auth/decorators.js';
import type { AuthenticatedRequest } from '../../src/auth/principal.js';

/** Echoes who the server thinks is calling. */
@Controller('probe-auth')
export class AuthProbeController {
  @Get('me')
  @RequireSession()
  me(@Req() request: AuthenticatedRequest) {
    return { principal: request.principal ?? null, device: request.device ?? null };
  }
}

/** One route per capability (`POST /api/v1/probe-matrix/<CAPABILITY>`), for table-driven tests. */
@Controller('probe-matrix')
export class MatrixProbeController {}

for (const capability of CAPABILITIES) {
  const prototype = MatrixProbeController.prototype as unknown as Record<string, unknown>;
  const key = `check_${capability}`;
  prototype[key] = function check(request: AuthenticatedRequest) {
    return {
      capability,
      ownershipRequired: request.ownershipRequired ?? false,
      override: request.override ?? null,
    };
  };
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
  Req()(prototype, key, 0);
  Post(capability)(prototype, key, descriptor);
  HttpCode(200)(prototype, key, descriptor);
  RequireCapability(capability)(prototype, key, descriptor);
}
