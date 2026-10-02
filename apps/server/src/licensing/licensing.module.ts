import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LicenceAgentService } from './licence-agent.service.js';
import { LicenceController } from './licence.controller.js';
import { FINGERPRINT_READER, SystemFingerprintReader } from './pc-fingerprint.js';

/** The local licence agent (P7-01c, LIC-002 to LIC-008). */
@Module({
  imports: [AuthModule],
  controllers: [LicenceController],
  providers: [
    LicenceAgentService,
    { provide: FINGERPRINT_READER, useFactory: () => new SystemFingerprintReader() },
  ],
  exports: [LicenceAgentService],
})
export class LicensingModule {}
