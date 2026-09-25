import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { DEFAULT_REALTIME_OPTIONS, REALTIME_OPTIONS, RealtimeGateway } from './realtime.gateway.js';

/** Live updates to apps over Socket.io (P0-12, ORD-010, NTF-006, NFR-P11). */
@Module({
  imports: [AuthModule, EventsModule],
  providers: [{ provide: REALTIME_OPTIONS, useValue: DEFAULT_REALTIME_OPTIONS }, RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
