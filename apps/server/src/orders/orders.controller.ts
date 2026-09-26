import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  OrderParams,
  type OrderView,
  SubmitOrderRequest,
  type SubmitOrderResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { OrdersService } from './orders.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Orders from staff surfaces: the POS and the waiter app (P1-06a, ORD-001). */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(200)
  @RequireCapability('ORDER_CREATE')
  submit(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(SubmitOrderRequest)) body: SubmitOrderRequest,
  ): Promise<SubmitOrderResponse> {
    const principal = principalOf(request);
    // Tablet and QR orders arrive through their own device routes (P3, P5), never as staff.
    if (body.source !== 'POS' && body.source !== 'WAITER_APP') {
      throw new AppError(
        422,
        'SOURCE_NOT_ALLOWED',
        'Staff devices submit orders as POS or WAITER_APP.',
      );
    }
    return this.orders.submit(
      {
        restaurantId: principal.restaurantId,
        staffId: principal.staffId,
        deviceId: principal.deviceId,
      },
      body,
    );
  }

  @Get(':orderId')
  @RequireCapability('ORDER_CREATE')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderParams)) params: OrderParams,
  ): Promise<OrderView> {
    return this.orders.get(principalOf(request).restaurantId, params.orderId);
  }
}
