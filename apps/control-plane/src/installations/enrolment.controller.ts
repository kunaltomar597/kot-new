import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { EnrolRequest, type EnrolResponse } from '@rp/contracts/control-plane';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { InstallationsService } from './installations.service.js';

@Controller('enrolments')
export class EnrolmentController {
  constructor(private readonly installations: InstallationsService) {}

  // Public: a new installation has no credential yet; the one-time code and the proof that it
  // holds the private key are its credential (ADR-0012). Rate-limited per client address.
  @Post()
  @HttpCode(201)
  @Public()
  enrol(
    @Req() request: Request,
    @Body(new ZodPipe(EnrolRequest)) body: EnrolRequest,
  ): Promise<EnrolResponse> {
    return this.installations.enrol(body, request.ip ?? 'unknown');
  }
}
