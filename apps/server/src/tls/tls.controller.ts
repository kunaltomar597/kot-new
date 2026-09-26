import { Controller, Get } from '@nestjs/common';
import type { TlsCaResponse } from '@rp/contracts';
import { Public } from '../auth/decorators.js';
import { AppError } from '../errors/app-error.js';
import { TlsService } from './tls.service.js';

@Controller('tls')
export class TlsController {
  constructor(private readonly tls: TlsService) {}

  // Public: a device needs the CA before it can pair; it is a public certificate (ADR-0011).
  @Get('ca')
  @Public()
  ca(): TlsCaResponse {
    const ca = this.tls.ca();
    if (ca === undefined) {
      throw new AppError(404, 'TLS_NOT_ENABLED', 'This server does not use TLS.');
    }
    return ca;
  }
}
