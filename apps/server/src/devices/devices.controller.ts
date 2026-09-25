import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  BindTableRequest,
  CreatePairingCodeRequest,
  DeviceChallengeRequest,
  type DeviceChallengeResponse,
  type DeviceListResponse,
  type DeviceSummary,
  DeviceTokenRequest,
  type DeviceTokenResponse,
  PairDeviceRequest,
  type PairedDevice,
  type PairingCodeResponse,
  RevokeDeviceRequest,
} from '@rp/contracts';
import type { Request } from 'express';
import { authErrors } from '../auth/auth-errors.js';
import { Public, RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { DevicesService } from './devices.service.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Rate-limit key for requests that come before a device is known. */
function clientKey(request: Request): string {
  return request.socket.remoteAddress ?? 'unknown';
}

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Device pairing, device authentication and device management (AUTH-007 to AUTH-009). */
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('pairing-codes')
  @RequireCapability('DEVICE_PAIR')
  createPairingCode(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CreatePairingCodeRequest)) body: CreatePairingCodeRequest,
  ): Promise<PairingCodeResponse> {
    return this.devices.createPairingCode(principalOf(request), body);
  }

  // Public: the first device has nothing to sign in with; limited to the server PC's loopback
  // address while no device is paired (see DevicesService.createBootstrapCode).
  @Post('pairing-codes/bootstrap')
  @Public()
  createBootstrapCode(@Req() request: Request): Promise<PairingCodeResponse> {
    return this.devices.createBootstrapCode(LOOPBACK.has(request.socket.remoteAddress ?? ''));
  }

  // Public: the device has no credential yet; the one-time code is the credential.
  @Post('pair')
  @Public()
  pair(
    @Req() request: Request,
    @Body(new ZodValidationPipe(PairDeviceRequest)) body: PairDeviceRequest,
  ): Promise<PairedDevice> {
    return this.devices.pair(body, clientKey(request));
  }

  // Public: first step of device authentication; a challenge alone grants nothing.
  @Post('challenge')
  @HttpCode(200)
  @Public()
  challenge(
    @Req() request: Request,
    @Body(new ZodValidationPipe(DeviceChallengeRequest)) body: DeviceChallengeRequest,
  ): DeviceChallengeResponse {
    return this.devices.challenge(body.deviceId, clientKey(request));
  }

  // Public: the signature over the challenge with the paired key is the credential.
  @Post('token')
  @HttpCode(200)
  @Public()
  token(
    @Req() request: Request,
    @Body(new ZodValidationPipe(DeviceTokenRequest)) body: DeviceTokenRequest,
  ): Promise<DeviceTokenResponse> {
    return this.devices.issueToken(body, clientKey(request));
  }

  @Get()
  @RequireCapability('DEVICE_PAIR')
  list(@Req() request: AuthenticatedRequest): Promise<DeviceListResponse> {
    return this.devices.list(principalOf(request));
  }

  @Post(':deviceId/revoke')
  @HttpCode(200)
  @RequireCapability('DEVICE_PAIR')
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body(new ZodValidationPipe(RevokeDeviceRequest)) body: RevokeDeviceRequest,
  ): Promise<DeviceSummary> {
    return this.devices.revoke(principalOf(request), deviceId, body.reason);
  }

  @Put(':deviceId/table')
  @RequireCapability('DEVICE_PAIR')
  bindTable(
    @Req() request: AuthenticatedRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body(new ZodValidationPipe(BindTableRequest)) body: BindTableRequest,
  ): Promise<DeviceSummary> {
    return this.devices.bindTable(principalOf(request), deviceId, body.tableId);
  }
}
