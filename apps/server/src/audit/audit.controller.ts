import { Controller, Get } from '@nestjs/common';
import type { AuditVerifyResponse } from '@rp/contracts';
import { RequireCapability } from '../auth/decorators.js';
import { AuditService } from './audit.service.js';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Recomputes the hash chain (AUD-003); the dashboard's verification tool calls this. */
  @Get('verify')
  @RequireCapability('AUDIT_VIEW')
  verify(): Promise<AuditVerifyResponse> {
    return this.audit.verify();
  }
}
