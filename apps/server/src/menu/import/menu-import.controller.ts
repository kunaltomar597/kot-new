import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { type MenuImportReport, MenuImportRequest, type MenuTemplateResponse } from '@rp/contracts';
import { authErrors } from '../../auth/auth-errors.js';
import { RequireCapability } from '../../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../../auth/principal.js';
import { ZodValidationPipe } from '../../validation/zod-validation.pipe.js';
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
