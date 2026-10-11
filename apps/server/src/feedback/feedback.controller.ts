import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  EraseDinerContactRequest,
  type EraseDinerContactResponse,
  TabletFeedbackRequest,
  type TabletFeedbackResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireDevice } from '../auth/decorators.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { FeedbackService } from './feedback.service.js';

function deviceOf(request: AuthenticatedRequest): AuthenticatedDevice {
  if (request.device === undefined) throw authErrors.deviceNotRecognised();
  return request.device;
}

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Feedback from the table tablet after the bill (TAB-014). */
@Controller('devices/current/feedback')
@RequireDevice(['TABLE_TABLET'])
export class TabletFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  submit(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(TabletFeedbackRequest)) body: TabletFeedbackRequest,
  ): Promise<TabletFeedbackResponse> {
    return this.feedback.submitFromTablet(deviceOf(request), TabletFeedbackRequest.parse(body));
  }
}

/** A diner's number erased on their request (DATA-011). */
@Controller('diner-contacts')
export class DinerContactsController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post('erase')
  @HttpCode(200)
  @RequireCapability('DATA_ADMIN')
  erase(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(EraseDinerContactRequest)) body: EraseDinerContactRequest,
  ): Promise<EraseDinerContactResponse> {
    return this.feedback.erase(principalOf(request), body.phone, body.reason);
  }
}
