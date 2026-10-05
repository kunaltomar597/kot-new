import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import { APK_MEDIA_TYPE, type CurrentAppBuildResponse } from '@rp/contracts';
import type { Response } from 'express';
import { authErrors } from '../auth/auth-errors.js';
import { RequireDevice } from '../auth/decorators.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import { type AuthenticatedRequest, deviceOf } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { appKindOfDevice, AppBuildsService, type CheckedAppBuild } from './app-builds.service.js';

function deviceFrom(request: AuthenticatedRequest): AuthenticatedDevice {
  const device = deviceOf(request);
  if (device === undefined) throw authErrors.unauthenticated();
  return device;
}

/**
 * A phone's or tablet's own APK from this PC (WTR-001, UPD-001, P7-04e2): its details, then the
 * file, which the device's own HTTP client downloads over the pinned LAN CA and checks against
 * the SHA-256 before Android installs it. Open to apps the server no longer serves (N-1,
 * `client-version.ts`), so a refused app can update itself.
 */
@Controller('devices/current/app-build')
@RequireDevice()
export class AppBuildsController {
  private readonly logger = new Logger(AppBuildsController.name);

  constructor(private readonly builds: AppBuildsService) {}

  @Get()
  async current(@Req() request: AuthenticatedRequest): Promise<CurrentAppBuildResponse> {
    return { build: (await this.buildFor(deviceFrom(request)))?.view ?? null };
  }

  @Get('apk')
  async apk(@Req() request: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const device = deviceFrom(request);
    const build = await this.buildFor(device);
    if (build === undefined) {
      throw new AppError(404, 'NO_APP_BUILD', 'This PC has no new version of this app.');
    }
    this.logger.log(
      { deviceId: device.deviceId, kind: build.view.kind, version: build.view.version },
      'A device downloads its app',
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.attachment(`${build.view.kind}-${build.view.version}.apk`);
    response.type(APK_MEDIA_TYPE);
    await new Promise<void>((resolve, reject) => {
      response.sendFile(build.path, { dotfiles: 'deny', cacheControl: false }, (error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private async buildFor(device: AuthenticatedDevice): Promise<CheckedAppBuild | undefined> {
    const kind = appKindOfDevice(device.type);
    return kind === undefined ? undefined : this.builds.forKind(kind);
  }
}
