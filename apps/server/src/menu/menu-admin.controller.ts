import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  CategoryRequest,
  type CategoryView,
  ItemRequest,
  type ItemView,
  MenuArchiveRequest,
  type MenuDraftResponse,
  MenuEntityParams,
  ModifierGroupRequest,
  type ModifierGroupView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { MenuAdminService } from './menu-admin.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

const params = new ZodValidationPipe(MenuEntityParams);
const archive = new ZodValidationPipe(MenuArchiveRequest);

/** Menu management for managers and the Owner (P1-03a, MGR-005, BRD §4.2 "manage menu"). */
@Controller('menu')
@RequireCapability('MENU_MANAGE')
export class MenuAdminController {
  constructor(private readonly menu: MenuAdminService) {}

  @Get('draft')
  draft(@Req() request: AuthenticatedRequest): Promise<MenuDraftResponse> {
    return this.menu.draft(principalOf(request).restaurantId);
  }

  @Post('categories')
  createCategory(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CategoryRequest)) body: CategoryRequest,
  ): Promise<CategoryView> {
    return this.menu.createCategory(principalOf(request), body);
  }

  @Put('categories/:id')
  updateCategory(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
    @Body(new ZodValidationPipe(CategoryRequest)) body: CategoryRequest,
  ): Promise<CategoryView> {
    return this.menu.updateCategory(principalOf(request), id, body);
  }

  @Post('categories/:id/archive')
  @HttpCode(200)
  archiveCategory(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
    @Body(archive) body: MenuArchiveRequest,
  ): Promise<CategoryView> {
    return this.menu.archiveCategory(principalOf(request), id, body.reason);
  }

  @Post('categories/:id/restore')
  @HttpCode(200)
  restoreCategory(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
  ): Promise<CategoryView> {
    return this.menu.restoreCategory(principalOf(request), id);
  }

  @Post('modifier-groups')
  createModifierGroup(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ModifierGroupRequest)) body: ModifierGroupRequest,
  ): Promise<ModifierGroupView> {
    return this.menu.createModifierGroup(principalOf(request), body);
  }

  @Put('modifier-groups/:id')
  updateModifierGroup(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
    @Body(new ZodValidationPipe(ModifierGroupRequest)) body: ModifierGroupRequest,
  ): Promise<ModifierGroupView> {
    return this.menu.updateModifierGroup(principalOf(request), id, body);
  }

  @Post('modifier-groups/:id/archive')
  @HttpCode(200)
  archiveModifierGroup(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
    @Body(archive) body: MenuArchiveRequest,
  ): Promise<ModifierGroupView> {
    return this.menu.archiveModifierGroup(principalOf(request), id, body.reason);
  }

  @Post('modifier-groups/:id/restore')
  @HttpCode(200)
  restoreModifierGroup(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
  ): Promise<ModifierGroupView> {
    return this.menu.restoreModifierGroup(principalOf(request), id);
  }

  @Post('items')
  createItem(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ItemRequest)) body: ItemRequest,
  ): Promise<ItemView> {
    return this.menu.createItem(principalOf(request), body);
  }

  @Put('items/:id')
  updateItem(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
    @Body(new ZodValidationPipe(ItemRequest)) body: ItemRequest,
  ): Promise<ItemView> {
    return this.menu.updateItem(principalOf(request), id, body);
  }

  @Post('items/:id/archive')
  @HttpCode(200)
  archiveItem(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
    @Body(archive) body: MenuArchiveRequest,
  ): Promise<ItemView> {
    return this.menu.archiveItem(principalOf(request), id, body.reason);
  }

  @Post('items/:id/restore')
  @HttpCode(200)
  restoreItem(
    @Req() request: AuthenticatedRequest,
    @Param(params) { id }: MenuEntityParams,
  ): Promise<ItemView> {
    return this.menu.restoreItem(principalOf(request), id);
  }
}
