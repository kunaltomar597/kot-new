import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { FirstRunRequest, type FirstRunResponse, type FirstRunStatus } from '@rp/contracts';
import type { Request } from 'express';
import { Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { FirstRunService } from './first-run.service.js';

/** The server PC's own addresses: a first run is only ever done sitting at that PC. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** A fresh install's restaurant and Owner (ONB-001, P7-07b). */
@Controller('first-run')
export class FirstRunController {
  constructor(private readonly firstRun: FirstRunService) {}

  // Public: nothing exists to sign in with; it says only whether a restaurant exists.
  @Get()
  @Public()
  status(): Promise<FirstRunStatus> {
    return this.firstRun.status();
  }

  // Public: limited to the server PC's loopback address while no restaurant exists.
  @Post()
  @Public()
  complete(
    @Req() request: Request,
    @Body(new ZodValidationPipe(FirstRunRequest)) body: FirstRunRequest,
  ): Promise<FirstRunResponse> {
    return this.firstRun.complete(body, LOOPBACK.has(request.socket.remoteAddress ?? ''));
  }
}
