import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { DigitalBillRequest, type DigitalBillView } from '@rp/contracts/control-plane';
import type { Request, Response } from 'express';
import { type InstallationRequest, installationOf } from '../auth/installation.guard.js';
import { Public } from '../auth/public.decorator.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { BILL_PAGE_HEADERS } from './bill-page.js';
import { DigitalBillsService } from './digital-bills.service.js';

/** Digital bills (BILL-012, P7-09a): sent for a restaurant's PC, opened by its diners. */
@Controller()
export class DigitalBillsController {
  constructor(private readonly bills: DigitalBillsService) {}

  @Post('digital-bills')
  @HttpCode(200)
  send(
    @Req() request: InstallationRequest,
    @Body(new ZodPipe(DigitalBillRequest)) body: DigitalBillRequest,
  ): Promise<DigitalBillView> {
    return this.bills.send(installationOf(request), body);
  }

  // Public: diners open it from the message; the 256-bit token in the link is the credential.
  @Public()
  @Get('bills/:token')
  async page(
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const answer = await this.bills.page(token, request.ip ?? 'unknown');
    response.status(answer.status).set(BILL_PAGE_HEADERS).send(answer.html);
  }
}
