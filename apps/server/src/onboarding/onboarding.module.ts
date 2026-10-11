import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CloudModule } from '../cloud/cloud.module.js';
import { FirstRunController } from './first-run.controller.js';
import { FirstRunService } from './first-run.service.js';
import { OnboardingController } from './onboarding.controller.js';
import { OnboardingService } from './onboarding.service.js';

/** The first-run setup and activation (ONB-003, ONB-004, P7-07). */
@Module({
  imports: [AuthModule, CloudModule],
  controllers: [OnboardingController, FirstRunController],
  providers: [OnboardingService, FirstRunService],
})
export class OnboardingModule {}
