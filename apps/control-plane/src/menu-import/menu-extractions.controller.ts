import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  MenuExtractionParams,
  MenuExtractionRequest,
  type MenuExtractionView,
} from '@rp/contracts/control-plane';
import { type InstallationRequest, installationOf } from '../auth/installation.guard.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { MenuExtractionsService } from './menu-extractions.service.js';

/** AI-assisted menu import (ONB-006, VCP-008): signed by the restaurant's installation. */
@Controller('menu-extractions')
export class MenuExtractionsController {
  constructor(private readonly extractions: MenuExtractionsService) {}

  @Post()
  @HttpCode(202)
  create(
    @Req() request: InstallationRequest,
    @Body(new ZodPipe(MenuExtractionRequest)) body: MenuExtractionRequest,
  ): Promise<MenuExtractionView> {
    return this.extractions.create(installationOf(request), body);
  }

  @Get(':extractionId')
  get(
    @Req() request: InstallationRequest,
    @Param(new ZodPipe(MenuExtractionParams)) { extractionId }: MenuExtractionParams,
  ): Promise<MenuExtractionView> {
    return this.extractions.get(installationOf(request), extractionId);
  }
}
