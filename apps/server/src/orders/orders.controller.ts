import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApproveAtTableRequest,
  ApproveOrderRequest,
  FireOrderRequest,
  ModifyOrderItemRequest,
  OrderItemEndRequest,
  OrderItemParams,
  OrderItemStatusRequest,
  type OrderListResponse,
  type OrderFeedResponse,
  OrderParams,
  type OrderView,
  type PendingApprovalsResponse,
  RejectOrderRequest,
  SubmitOrderRequest,
  type SubmitOrderResponse,
  TableSessionParams,
  TabletOrderRequest,
  type TabletOrdersResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireDevice, RequireSession } from '../auth/decorators.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import { actorOf, type AuthenticatedRequest, type Principal } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { type Approver, OrderApprovalsService } from './order-approvals.service.js';
import { OrderFeedService } from './order-feed.service.js';
import { OrderItemsService } from './order-items.service.js';
import { OrdersService } from './orders.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The person approving diners' orders; waiters only their own tables (ORD-003, WTR-004). */
function approverOf(request: AuthenticatedRequest): Approver {
  const principal = principalOf(request);
  return {
    restaurantId: principal.restaurantId,
    staffId: principal.staffId,
    deviceId: principal.deviceId,
    ownOnly: request.ownershipRequired === true,
  };
}

function deviceOf(request: AuthenticatedRequest): AuthenticatedDevice {
  if (request.device === undefined) throw authErrors.deviceNotRecognised();
  return request.device;
}

/** A diner's orders from the table tablet, and "Approve at table" (P3-03a, AUTH-009). */
@Controller('devices/current/orders')
@RequireDevice()
export class TabletOrdersController {
  constructor(private readonly approvals: OrderApprovalsService) {}

  @Post()
  @HttpCode(200)
  submit(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(TabletOrderRequest)) body: TabletOrderRequest,
  ): Promise<SubmitOrderResponse> {
    return this.approvals.submitFromTablet(deviceOf(request), body);
  }

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<TabletOrdersResponse> {
    return this.approvals.listForTablet(deviceOf(request));
  }

  @Post(':orderId/approve')
  @HttpCode(200)
  approve(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderParams)) params: OrderParams,
    @Body(new ZodValidationPipe(ApproveAtTableRequest)) body: ApproveAtTableRequest,
  ): Promise<OrderView> {
    const parsed = ApproveAtTableRequest.parse(body);
    return this.approvals.approveAtTable(deviceOf(request), params.orderId, parsed);
  }
}

/** Orders from staff surfaces: the POS and the waiter app (P1-06a, ORD-001). */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly approvals: OrderApprovalsService,
    private readonly items: OrderItemsService,
  ) {}

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

  // Declared before `:orderId` so these paths are not read as an order id.
  @Get('pending-approval')
  @RequireCapability('ORDER_APPROVE_CUSTOMER')
  pending(@Req() request: AuthenticatedRequest): Promise<PendingApprovalsResponse> {
    return this.approvals.pending(approverOf(request));
  }

  @Post(':orderId/approve')
  @HttpCode(200)
  @RequireCapability('ORDER_APPROVE_CUSTOMER')
  approve(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderParams)) params: OrderParams,
    @Body(new ZodValidationPipe(ApproveOrderRequest)) body: ApproveOrderRequest,
  ): Promise<OrderView> {
    const parsed = ApproveOrderRequest.parse(body);
    return this.approvals.approve(approverOf(request), params.orderId, parsed.changes);
  }

  // ORD-016: held items to the kitchen, by anyone who may order.
  @Post(':orderId/fire')
  @HttpCode(200)
  @RequireCapability('ORDER_CREATE')
  fire(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderParams)) params: OrderParams,
    @Body(new ZodValidationPipe(FireOrderRequest)) body: FireOrderRequest,
  ): Promise<OrderView> {
    return this.items.fire(
      principalOf(request),
      params.orderId,
      body.orderItemIds,
      request.ownershipRequired === true,
    );
  }

  @Post(':orderId/reject')
  @HttpCode(200)
  @RequireCapability('ORDER_APPROVE_CUSTOMER')
  reject(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderParams)) params: OrderParams,
    @Body(new ZodValidationPipe(RejectOrderRequest)) body: RejectOrderRequest,
  ): Promise<OrderView> {
    return this.approvals.reject(approverOf(request), params.orderId, body);
  }

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

/** The manager dashboard's live order feed (P4-01, MGR-003): managers and owners (MGR-001). */
@Controller('order-feed')
export class OrderFeedController {
  constructor(private readonly feed: OrderFeedService) {}

  @Get()
  @RequireCapability('OPERATIONS_CONFIGURE')
  get(@Req() request: AuthenticatedRequest): Promise<OrderFeedResponse> {
    return this.feed.feed(principalOf(request).restaurantId);
  }
}
