import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  type KdsTicket,
  KdsTicketParams,
  KdsTicketsQuery,
  type KdsTicketsResponse,
  type NotifyManagerResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import { type Actor, actorOf, type AuthenticatedRequest } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { KdsService } from './kds.service.js';

function actor(request: AuthenticatedRequest): Actor {
  const found = actorOf(request);
  if (found === undefined) throw authErrors.unauthenticated();
  return found;
}

/**
 * The kitchen display (P1-09a). Every route admits a kitchen screen in station mode (nobody
 * signed in, AUTH-005) as well as signed-in people granted the kitchen steps.
 */
@Controller('kds/tickets')
export class KdsController {
  constructor(private readonly kds: KdsService) {}

  @Get()
  @RequireCapability('ITEM_MARK_PREPARING_READY', { stationMode: true })
  tickets(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(KdsTicketsQuery)) query: KdsTicketsQuery,
  ): Promise<KdsTicketsResponse> {
    return this.kds.tickets(actor(request), query);
  }

  @Post(':kotId/bump')
  @HttpCode(200)
  @RequireCapability('ITEM_MARK_PREPARING_READY', { stationMode: true })
  bump(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(KdsTicketParams)) params: KdsTicketParams,
  ): Promise<KdsTicket> {
    return this.kds.bump(actor(request), params.kotId);
  }

  @Post(':kotId/recall')
  @HttpCode(200)
  @RequireCapability('ITEM_MARK_PREPARING_READY', { stationMode: true })
  recall(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(KdsTicketParams)) params: KdsTicketParams,
  ): Promise<KdsTicket> {
    return this.kds.recall(actor(request), params.kotId);
  }

  @Post(':kotId/notify-manager')
  @HttpCode(200)
  @RequireCapability('ITEM_MARK_PREPARING_READY', { stationMode: true })
  notifyManager(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(KdsTicketParams)) params: KdsTicketParams,
  ): Promise<NotifyManagerResponse> {
    return this.kds.notifyManager(actor(request), params.kotId);
  }
}
