import { Module } from '@nestjs/common';
import { DinerContactsController, TabletFeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

/** Diners' feedback and the consent-based contacts that come with it (P3-05b). */
@Module({
  controllers: [TabletFeedbackController, DinerContactsController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
