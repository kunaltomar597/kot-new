import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  DeviceHealthRequest,
  KioskExitRequest,
  type KioskExitResponse,
  type TabletTableView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireDevice } from '../auth/decorators.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { TabletService } from './tablet.service.js';

function deviceOf(request: AuthenticatedRequest): AuthenticatedDevice {
  if (request.device === undefined) throw authErrors.deviceNotRecognised();
  return request.device;
}

/** What a device asks about itself (P3-01a): a tablet's table and kiosk exit, any app's health. */
@Controller('devices/current')
@RequireDevice(['TABLE_TABLET'])
export class TabletController {
  constructor(private readonly tablets: TabletService) {}

  @Get('table')
  table(@Req() request: AuthenticatedRequest): Promise<TabletTableView> {
    return this.tablets.table(deviceOf(request));
  }

  /** The Android apps' battery and connection (TAB-015); a kitchen screen may report too. */
  @Post('health')
  @RequireDevice(['KDS', 'WAITER_PHONE', 'TABLE_TABLET'])
  @HttpCode(204)
  async health(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(DeviceHealthRequest)) body: DeviceHealthRequest,
  ): Promise<void> {
    await this.tablets.reportHealth(deviceOf(request), body);
  }

  @Post('kiosk-exit')
  @HttpCode(200)
  exitKiosk(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(KioskExitRequest)) body: KioskExitRequest,
  ): Promise<KioskExitResponse> {
    return this.tablets.exitKiosk(deviceOf(request), body);
  }
}
