import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditListQuery, type AuditListResponse, type AuditVerifyResponse } from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';
import { AuditViewerService } from './audit-viewer.service.js';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly viewer: AuditViewerService,
  ) {}

  /** The audit viewer (P4-07a, AUD-005): a filtered page of entries, newest first. */
  @Get()
  @RequireCapability('AUDIT_VIEW')
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(AuditListQuery)) query: AuditListQuery,
  ): Promise<AuditListResponse> {
    if (request.principal === undefined) throw authErrors.unauthenticated();
    return this.viewer.list(request.principal.restaurantId, query);
  }

  /** Recomputes the hash chain (AUD-003); the dashboard's verification tool calls this. */
  @Get('verify')
  @RequireCapability('AUDIT_VIEW')
  verify(): Promise<AuditVerifyResponse> {
    return this.audit.verify();
  }
}
