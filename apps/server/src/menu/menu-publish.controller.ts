import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  ComboRequest,
  type ComboView,
  ItemAvailabilityRequest,
  type ItemAvailabilityView,
  MenuEntityParams,
  type MenuPublishResponse,
  type MenuSnapshot,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireDevice } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { MenuPublishService } from './menu-publish.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Combos, live availability and the published menu (P1-03b). */
@Controller('menu')
export class MenuPublishController {
  constructor(private readonly menu: MenuPublishService) {}

  // Any paired device: tablets and waiter apps cache it and refresh on MenuPublished (MENU-013).
  @Get()
  @RequireDevice()
  current(@Req() request: AuthenticatedRequest): Promise<MenuSnapshot> {
    if (request.device === undefined) throw authErrors.deviceNotRecognised();
    return this.menu.current(request.device.restaurantId);
  }

  @Post('publish')
  @HttpCode(200)
  @RequireCapability('MENU_MANAGE')
  publish(@Req() request: AuthenticatedRequest): Promise<MenuPublishResponse> {
    return this.menu.publish(principalOf(request));
  }

  @Put('items/:id/combo')
  @RequireCapability('MENU_MANAGE')
  setCombo(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(MenuEntityParams)) { id }: MenuEntityParams,
    @Body(new ZodValidationPipe(ComboRequest)) body: ComboRequest,
  ): Promise<ComboView> {
    return this.menu.setCombo(principalOf(request), id, body);
  }

  @Put('items/:id/availability')
  @RequireCapability('STOCK_MANAGE')
  setAvailability(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(MenuEntityParams)) { id }: MenuEntityParams,
    @Body(new ZodValidationPipe(ItemAvailabilityRequest)) body: ItemAvailabilityRequest,
  ): Promise<ItemAvailabilityView> {
    return this.menu.setAvailability(principalOf(request), id, body);
  }
}
