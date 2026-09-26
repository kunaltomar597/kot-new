import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  AssignSessionWaiterRequest,
  CloseWithoutBillRequest,
  MoveTableRequest,
  OpenTableRequest,
  type TableOverviewResponse,
  TableParams,
  TableSessionParams,
  type TableSessionView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireSession } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { TableSessionsService } from './table-sessions.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Table sessions and the live overview (P1-02b, TBL-003 to TBL-005, TBL-007). */
@Controller()
export class TableSessionsController {
  constructor(private readonly sessions: TableSessionsService) {}

  @Get('tables/overview')
  @RequireSession()
  async overview(@Req() request: AuthenticatedRequest): Promise<TableOverviewResponse> {
    return { tables: await this.sessions.overview(principalOf(request).restaurantId) };
  }

  @Post('tables/:tableId/open')
  @RequireCapability('ORDER_CREATE')
  open(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableParams)) params: TableParams,
    @Body(new ZodValidationPipe(OpenTableRequest)) body: OpenTableRequest,
  ): Promise<TableSessionView> {
    return this.sessions.open(principalOf(request), params.tableId, body);
  }

  @Post('table-sessions/:sessionId/request-bill')
  @HttpCode(200)
  @RequireCapability('BILL_REQUEST')
  requestBill(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableSessionParams)) params: TableSessionParams,
  ): Promise<TableSessionView> {
    const from = request.device?.type === 'WAITER_PHONE' ? 'WAITER_APP' : 'POS';
    return this.sessions.requestBill(principalOf(request), params.sessionId, from);
  }

  @Post('table-sessions/:sessionId/close-without-bill')
  @HttpCode(200)
  @RequireCapability('ORDER_CREATE')
  close(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableSessionParams)) params: TableSessionParams,
    @Body(new ZodValidationPipe(CloseWithoutBillRequest)) body: CloseWithoutBillRequest,
  ): Promise<TableSessionView> {
    return this.sessions.closeWithoutBill(principalOf(request), params.sessionId, body.reason);
  }

  // Waiters hold TABLE_MOVE_MERGE for their own tables only (BRD §4.2): the guard marks it.
  @Post('table-sessions/:sessionId/move')
  @HttpCode(200)
  @RequireCapability('TABLE_MOVE_MERGE')
  move(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableSessionParams)) params: TableSessionParams,
    @Body(new ZodValidationPipe(MoveTableRequest)) body: MoveTableRequest,
  ): Promise<TableSessionView> {
    return this.sessions.move(
      principalOf(request),
      params.sessionId,
      body.toTableId,
      request.ownershipRequired === true,
    );
  }

  @Put('table-sessions/:sessionId/waiter')
  @RequireCapability('STAFF_MANAGE')
  assignWaiter(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableSessionParams)) params: TableSessionParams,
    @Body(new ZodValidationPipe(AssignSessionWaiterRequest)) body: AssignSessionWaiterRequest,
  ): Promise<TableSessionView> {
    return this.sessions.assignWaiter(
      principalOf(request),
      params.sessionId,
      body.waiterId,
      body.reason,
    );
  }
}
