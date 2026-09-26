import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import {
  CONTROL_PLANE_OPTIONS,
  DEFAULT_CONTROL_PLANE_OPTIONS,
  HeartbeatService,
} from './heartbeat.service.js';

/** The local server's link to the Vendor Control Plane (P0-17b, ADR-0012). */
@Module({
  imports: [AuthModule],
  providers: [
    { provide: CONTROL_PLANE_OPTIONS, useValue: DEFAULT_CONTROL_PLANE_OPTIONS },
    HeartbeatService,
  ],
  exports: [HeartbeatService],
})
export class CloudModule {}
