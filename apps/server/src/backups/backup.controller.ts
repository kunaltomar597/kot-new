import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  type BackupsResponse,
  type RecoveryKeyResponse,
  RestoreBackupRequest,
  type RestoreBackupResponse,
  type StartBackupResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { BackupService } from './backup.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/**
 * The backups on the System page, "Back up now" (DATA-002, DATA-005, P7-05a), and the Owner's
 * restore and recovery key (DATA-004, P7-05b).
 */
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

  @Post('restore')
  @HttpCode(202)
  @RequireCapability('DATA_ADMIN')
  restore(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RestoreBackupRequest)) body: RestoreBackupRequest,
  ): Promise<RestoreBackupResponse> {
    return this.backups.requestRestore(principalOf(request), body);
  }

  @Post('recovery-key')
  @HttpCode(200)
  @RequireCapability('DATA_ADMIN')
  recoveryKey(@Req() request: AuthenticatedRequest): Promise<RecoveryKeyResponse> {
    return this.backups.recoveryKey(principalOf(request));
  }
}
