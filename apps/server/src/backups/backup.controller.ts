import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { BackupsResponse, StartBackupResponse } from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { BackupService } from './backup.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The backups on the System page and "Back up now" (DATA-002, DATA-005, P7-05a). */
@Controller('backups')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get()
  @RequireCapability('OPERATIONS_CONFIGURE')
  list(@Req() request: AuthenticatedRequest): Promise<BackupsResponse> {
    return this.backups.overview(principalOf(request).restaurantId);
  }

  @Post()
  @HttpCode(202)
  @RequireCapability('OPERATIONS_CONFIGURE')
  async start(@Req() request: AuthenticatedRequest): Promise<StartBackupResponse> {
    return { run: await this.backups.backUpNow(principalOf(request)) };
  }
}
