import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { MenuModule } from '../menu/menu.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BestSellers } from './best-sellers.js';
import { RECOMMENDATION_CLOCK, SYSTEM_RECOMMENDATION_CLOCK } from './clock.js';
import { RecommendationOrders } from './recommendation-orders.js';
import { RecommendationPreferencesService } from './recommendation-preferences.service.js';
import { RecommendationRulesService } from './recommendation-rules.service.js';
import {
  RecommendationPreferencesController,
  RecommendationRulesController,
  RecommendationsController,
  TabletRecommendationsController,
} from './recommendations.controller.js';
import { RecommendationsService } from './recommendations.service.js';

/**
 * The recommendation engine v1 (P3-04, REC-001 to REC-008, REC-011): suggestions for the waiter
 * app, the POS and the table tablet from the restaurant's rules and best sellers, with the
 * manager's pinned, boosted and blocked dishes (REC-009, P4-03c), the rules and preferences APIs,
 * and tracking. The tablet's and the phones' suggestion rows are P3-05; learned pairings P6-02.
 */
@Module({
  imports: [AuthModule, EventsModule, MenuModule, SettingsModule],
  controllers: [
    RecommendationsController,
    TabletRecommendationsController,
    RecommendationRulesController,
    RecommendationPreferencesController,
  ],
  providers: [
    RecommendationsService,
    RecommendationRulesService,
    RecommendationPreferencesService,
    RecommendationOrders,
    BestSellers,
    { provide: RECOMMENDATION_CLOCK, useValue: SYSTEM_RECOMMENDATION_CLOCK },
  ],
  exports: [RecommendationsService, BestSellers],
})
export class RecommendationsModule {}
