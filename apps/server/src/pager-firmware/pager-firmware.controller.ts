import { Controller, Get, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import {
  PagerFirmwareDownloadParams,
  type PagerFirmwarePagerView,
  type PagerFirmwareResponse,
  PagerParams,
} from '@rp/contracts';
import type { Response } from 'express';
import { authErrors } from '../auth/auth-errors.js';
import { Public, RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { PagerFirmwareService } from './pager-firmware.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The firmware this PC passes on to its pagers, and "Update now" (PGR-011, UPD-004, P2-04b). */
@Controller('pagers')
export class PagerFirmwareController {
  constructor(private readonly firmware: PagerFirmwareService) {}

  @Get('firmware')
  @RequireCapability('DEVICE_PAIR')
  status(@Req() request: AuthenticatedRequest): Promise<PagerFirmwareResponse> {
    return this.firmware.status(principalOf(request).restaurantId);
  }

  @Post(':deviceId/firmware-update')
  @HttpCode(200)
  @RequireCapability('UPDATE_INSTALL_NOW')
  updateNow(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PagerParams)) { deviceId }: PagerParams,
  ): Promise<PagerFirmwarePagerView> {
    return this.firmware.requestNow(principalOf(request), deviceId);
  }
}

/**
 * The firmware image a pager downloads (PGR-011, UPD-007). Public: a pager has no device token.
 * The path's random token went to that pager alone, on its own MQTT topic behind its credential
 * and the broker's ACL, and expires in 15 minutes; the image is signed and the pager checks it.
 */
@Controller('pager-firmware')
@Public()
export class PagerFirmwareDownloadController {
  private readonly logger = new Logger(PagerFirmwareDownloadController.name);

  constructor(private readonly firmware: PagerFirmwareService) {}

  @Get(':token')
  async download(
    @Param(new ZodValidationPipe(PagerFirmwareDownloadParams))
    { token }: PagerFirmwareDownloadParams,
    @Res() response: Response,
  ): Promise<void> {
    const image = await this.firmware.download(token);
    if (image === undefined) {
      throw new AppError(404, 'NOT_FOUND', 'There is no such firmware download.');
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('application/octet-stream');
    await new Promise<void>((resolve, reject) => {
      response.sendFile(image.path, { dotfiles: 'deny', cacheControl: false }, (error) => {
        if (error === undefined) resolve();
        else {
          this.logger.warn({ err: error, version: image.version }, 'A firmware download broke off');
          reject(error);
        }
      });
    });
  }
}
