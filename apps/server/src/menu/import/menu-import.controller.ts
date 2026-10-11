import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  AiMenuImportParams,
  AiMenuImportRequest,
  type AiMenuImportView,
  type MenuImportReport,
  MenuImportRequest,
  MenuReviewRequest,
  type MenuTemplateResponse,
} from '@rp/contracts';
import { authErrors } from '../../auth/auth-errors.js';
import { RequireCapability } from '../../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../../auth/principal.js';
import { ZodValidationPipe } from '../../validation/zod-validation.pipe.js';
import { AiMenuImportService } from './ai-menu-import.service.js';
import { MenuImportService } from './menu-import.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

const body = new ZodValidationPipe(MenuImportRequest);

/** Menu import from the vendor template (P1-05, ONB-005). */
@Controller('menu/import')
@RequireCapability('MENU_MANAGE')
export class MenuImportController {
  constructor(private readonly imports: MenuImportService) {}

  @Get('template')
  template(): Promise<MenuTemplateResponse> {
    return this.imports.template();
  }

  @Post('check')
  @HttpCode(200)
  check(
    @Req() request: AuthenticatedRequest,
    @Body(body) payload: MenuImportRequest,
  ): Promise<MenuImportReport> {
    return this.imports.check(principalOf(request), payload);
  }

  @Post()
  @HttpCode(200)
  commit(
    @Req() request: AuthenticatedRequest,
    @Body(body) payload: MenuImportRequest,
  ): Promise<MenuImportReport> {
    return this.imports.commit(principalOf(request), payload);
  }
}

/** AI-assisted import (P6-04b, ONB-006): read photos of the printed menu, check, import. */
@Controller('menu/ai-imports')
@RequireCapability('MENU_MANAGE')
export class AiMenuImportController {
  constructor(private readonly imports: AiMenuImportService) {}

  @Post()
  @HttpCode(202)
  start(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(AiMenuImportRequest)) payload: AiMenuImportRequest,
  ): Promise<AiMenuImportView> {
    return this.imports.start(principalOf(request), payload);
  }

  @Get(':importId')
  get(
    @Param(new ZodValidationPipe(AiMenuImportParams)) { importId }: AiMenuImportParams,
  ): Promise<AiMenuImportView> {
    return this.imports.get(importId);
  }

  @Post(':importId/commit')
  @HttpCode(200)
  commit(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(AiMenuImportParams)) { importId }: AiMenuImportParams,
    @Body(new ZodValidationPipe(MenuReviewRequest)) review: MenuReviewRequest,
  ): Promise<MenuImportReport> {
    return this.imports.commit(principalOf(request), importId, review);
  }
}
