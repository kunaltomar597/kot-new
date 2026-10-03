import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  type CloudBackupListResponse,
  CloudBackupParams,
  type CloudBackupView,
  CompleteCloudBackupRequest,
  StartCloudBackupRequest,
  type StartCloudBackupResponse,
  VendorInstallationParams,
} from '@rp/contracts/control-plane';
import type { Request, Response } from 'express';
import { type InstallationRequest, installationOf } from '../auth/installation.guard.js';
import { Public } from '../auth/public.decorator.js';
import { CpError } from '../errors/cp-error.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { Vendor } from '../vendor/vendor.guard.js';
import { CloudBackupsService, OBJECT_STORE } from './cloud-backups.service.js';
import { BadDigestError, LocalObjectStore } from './local-object-store.js';
import type { ObjectStore } from './object-store.js';

/** The encrypted cloud backup (DATA-003, P7-05d). */
@Controller()
export class CloudBackupsController {
  constructor(
    private readonly backups: CloudBackupsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore | null,
  ) {}

  // Signed by the installation (InstallationGuard): it only ever touches its own backups.
  @Post('cloud-backups')
  start(
    @Req() request: InstallationRequest,
    @Body(new ZodPipe(StartCloudBackupRequest)) body: StartCloudBackupRequest,
  ): Promise<StartCloudBackupResponse> {
    return this.backups.start(installationOf(request).id, body);
  }

  @Post('cloud-backups/:id/complete')
  @HttpCode(200)
  complete(
    @Req() request: InstallationRequest,
    @Param(new ZodPipe(CloudBackupParams)) params: CloudBackupParams,
    @Body(new ZodPipe(CompleteCloudBackupRequest)) body: CompleteCloudBackupRequest,
  ): Promise<CloudBackupView> {
    return this.backups.complete(installationOf(request).id, params.id, body);
  }

  @Post('cloud-backups/:id/abort')
  @HttpCode(204)
  async abort(
    @Req() request: InstallationRequest,
    @Param(new ZodPipe(CloudBackupParams)) params: CloudBackupParams,
  ): Promise<void> {
    await this.backups.abort(installationOf(request).id, params.id);
  }

  @Get('cloud-backups')
  async list(@Req() request: InstallationRequest): Promise<CloudBackupListResponse> {
    return { backups: await this.backups.list(installationOf(request).id) };
  }

  @Get('vendor/installations/:id/cloud-backups')
  @Vendor('FLEET_VIEW')
  async listForVendor(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<CloudBackupListResponse> {
    return { backups: await this.backups.listForVendor(params.id) };
  }

  // The local store's signed URLs (development and tests only; staging and production use S3,
  // where the PC talks to S3 directly). Public: the HMAC-signed grant in the URL is the
  // authorisation, as a presigned S3 URL is.
  @Put('object-store/:grant')
  @Public()
  async putPart(
    @Param('grant') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const store = this.localStore();
    const grant = store.verify(token);
    if (grant?.op !== 'PUT_PART') throw denied();
    const md5 = request.headers['content-md5'];
    try {
      const etag = await store.putPart(grant, request, typeof md5 === 'string' ? md5 : undefined);
      response.status(200).setHeader('ETag', etag).end();
    } catch (error) {
      if (error instanceof BadDigestError) {
        throw new CpError(400, 'BAD_DIGEST', 'The part does not match its Content-MD5.');
      }
      throw error;
    }
  }

  @Get('object-store/:grant')
  @Public()
  download(@Param('grant') token: string, @Res() response: Response): void {
    const store = this.localStore();
    const grant = store.verify(token);
    if (grant?.op !== 'GET') throw denied();
    response.status(200).setHeader('content-type', 'application/octet-stream');
    store.open(grant).pipe(response);
  }

  private localStore(): LocalObjectStore {
    if (!(this.store instanceof LocalObjectStore)) {
      throw new CpError(404, 'NOT_FOUND', 'There is no such address.');
    }
    return this.store;
  }
}

function denied(): CpError {
  return new CpError(403, 'URL_EXPIRED', 'This upload address has expired or is not valid.');
}
