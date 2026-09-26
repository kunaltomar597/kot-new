import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { HeartbeatRequest, type HeartbeatResponse } from '@rp/contracts/control-plane';
import { type InstallationRequest, installationOf } from '../auth/installation.guard.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { HeartbeatsService } from './heartbeats.service.js';

@Controller('heartbeats')
export class HeartbeatsController {
  constructor(private readonly heartbeats: HeartbeatsService) {}

  // Signed by the installation (InstallationGuard); it can only report for itself.
  @Post()
  @HttpCode(200)
  record(
    @Req() request: InstallationRequest,
    @Body(new ZodPipe(HeartbeatRequest)) heartbeat: HeartbeatRequest,
  ): Promise<HeartbeatResponse> {
    return this.heartbeats.record(installationOf(request), heartbeat);
  }
}
