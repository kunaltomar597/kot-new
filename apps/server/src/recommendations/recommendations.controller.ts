import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  ArchiveRequest,
  type RecommendationRuleListResponse,
  RecommendationRuleParams,
  RecommendationRuleRequest,
  type RecommendationRuleView,
  RecommendationsQuery,
  type RecommendationsResponse,
  RecordRecommendationEventsRequest,
  RecordTableRecommendationEventsRequest,
  TableRecommendationsQuery,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireDevice } from '../auth/decorators.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { RecommendationRulesService } from './recommendation-rules.service.js';
import { RecommendationsService } from './recommendations.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

function deviceOf(request: AuthenticatedRequest): AuthenticatedDevice {
  if (request.device === undefined) throw authErrors.deviceNotRecognised();
  return request.device;
}

/** Suggestions on the waiter app and the POS, and what was done with them (P3-04, WTR-011). */
@Controller('recommendations')
@RequireCapability('ORDER_CREATE')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  suggest(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(RecommendationsQuery)) query: RecommendationsQuery,
  ): Promise<RecommendationsResponse> {
    return this.recommendations.forStaff(principalOf(request), query);
  }

  @Post('events')
  @HttpCode(204)
  async track(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RecordRecommendationEventsRequest))
    body: RecordRecommendationEventsRequest,
  ): Promise<void> {
    await this.recommendations.trackForStaff(principalOf(request), body);
  }
}

/** The table tablet's suggestions for its own table (TAB-011, AUTH-009); its screens are P3-05. */
@Controller('devices/current/recommendations')
@RequireDevice()
export class TabletRecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  suggest(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(TableRecommendationsQuery)) query: TableRecommendationsQuery,
  ): Promise<RecommendationsResponse> {
    return this.recommendations.forTablet(deviceOf(request), query);
  }

  @Post('events')
  @HttpCode(204)
  async track(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RecordTableRecommendationEventsRequest))
    body: RecordTableRecommendationEventsRequest,
  ): Promise<void> {
    await this.recommendations.trackForTablet(deviceOf(request), body.events);
  }
}

/** The restaurant's recommendation rules (REC-002); the editor on the dashboard is P4-03. */
@Controller('recommendation-rules')
@RequireCapability('OPERATIONS_CONFIGURE')
export class RecommendationRulesController {
  constructor(private readonly rules: RecommendationRulesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<RecommendationRuleListResponse> {
    return this.rules.list(principalOf(request).restaurantId);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RecommendationRuleRequest)) body: RecommendationRuleRequest,
  ): Promise<RecommendationRuleView> {
    return this.rules.create(principalOf(request), body);
  }

  @Put(':ruleId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(RecommendationRuleParams)) { ruleId }: RecommendationRuleParams,
    @Body(new ZodValidationPipe(RecommendationRuleRequest)) body: RecommendationRuleRequest,
  ): Promise<RecommendationRuleView> {
    return this.rules.update(principalOf(request), ruleId, body);
  }

  @Post(':ruleId/archive')
  @HttpCode(200)
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(RecommendationRuleParams)) { ruleId }: RecommendationRuleParams,
    @Body(new ZodValidationPipe(ArchiveRequest)) body: ArchiveRequest,
  ): Promise<RecommendationRuleView> {
    return this.rules.archive(principalOf(request), ruleId, body.reason);
  }
}
