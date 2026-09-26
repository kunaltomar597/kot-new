import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ModifyOrderItemRequest,
  OrderItemEndRequest,
  OrderItemParams,
  OrderItemStatusRequest,
  type OrderListResponse,
  OrderParams,
  type OrderView,
  SubmitOrderRequest,
  type SubmitOrderResponse,
  TableSessionParams,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireSession } from '../auth/decorators.js';
import { actorOf, type AuthenticatedRequest, type Principal } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { OrderItemsService } from './order-items.service.js';
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

  // Declared before `:orderId` so "takeaway" is not read as an order id.
  @Get('takeaway')
  @RequireCapability('ORDER_CREATE')
  takeaway(@Req() request: AuthenticatedRequest): Promise<OrderListResponse> {
    return this.orders.listOpenTakeaway(principalOf(request).restaurantId);
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

/** A table session's orders, for the POS and the waiter app (P1-08b, TBL-007). */
@Controller('table-sessions')
export class SessionOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get(':sessionId/orders')
  @RequireCapability('ORDER_CREATE')
  list(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableSessionParams)) params: TableSessionParams,
  ): Promise<OrderListResponse> {
    return this.orders.listForSession(principalOf(request).restaurantId, params.sessionId);
  }
}

/** Item changes after an order is placed (P1-06b, ORD-010 to ORD-012). */
@Controller('order-items')
export class OrderItemsController {
  constructor(private readonly items: OrderItemsService) {}

  // Each step checks its own §4.2 grant in the service (kitchen marks, floor serves).
  // A kitchen screen in station mode marks its own station's items (AUTH-005, KDS-005).
  @Post(':orderItemId/status')
  @HttpCode(200)
  @RequireSession({ stationMode: true })
  status(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderItemParams)) params: OrderItemParams,
    @Body(new ZodValidationPipe(OrderItemStatusRequest)) body: OrderItemStatusRequest,
  ): Promise<OrderView> {
    const actor = actorOf(request);
    if (actor === undefined) throw authErrors.unauthenticated();
    return this.items.setStatus(actor, params.orderItemId, body.event);
  }

  // Waiters: their own tables only (OWN), which the guard marks for the service.
  @Post(':orderItemId/cancel')
  @HttpCode(200)
  @RequireCapability('ITEM_CANCEL_BEFORE_PREP')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderItemParams)) params: OrderItemParams,
    @Body(new ZodValidationPipe(OrderItemEndRequest)) body: OrderItemEndRequest,
  ): Promise<OrderView> {
    return this.items.cancel(
      principalOf(request),
      params.orderItemId,
      body.reason,
      request.ownershipRequired === true,
    );
  }

  // Cashiers and waiters: the guard has consumed a manager's override token (AUTH-011).
  @Post(':orderItemId/void')
  @HttpCode(200)
  @RequireCapability('ITEM_VOID_AFTER_PREP')
  void(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderItemParams)) params: OrderItemParams,
    @Body(new ZodValidationPipe(OrderItemEndRequest)) body: OrderItemEndRequest,
  ): Promise<OrderView> {
    return this.items.void(principalOf(request), params.orderItemId, body.reason, request.override);
  }

  @Patch(':orderItemId')
  @RequireCapability('ORDER_CREATE')
  modify(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderItemParams)) params: OrderItemParams,
    @Body(new ZodValidationPipe(ModifyOrderItemRequest)) body: ModifyOrderItemRequest,
  ): Promise<OrderView> {
    return this.items.modify(principalOf(request), params.orderItemId, body);
  }
}
