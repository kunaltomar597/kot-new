import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { CAPABILITIES, OVERRIDE_RECORD_TYPES } from '@rp/domain';
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

/**
 * One route per capability (`POST /api/v1/probe-matrix/<CAPABILITY>`), for table-driven tests; a
 * capability a manager approves for one record takes the record's id after it
 * (`.../<CAPABILITY>/<id>`, PC-T2).
 */
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
  const record = OVERRIDE_RECORD_TYPES[capability] === undefined ? undefined : 'recordId';
  Post(record === undefined ? capability : `${capability}/:${record}`)(prototype, key, descriptor);
  HttpCode(200)(prototype, key, descriptor);
  RequireCapability(capability, record === undefined ? {} : { record })(prototype, key, descriptor);
}
