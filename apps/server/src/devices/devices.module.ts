import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TlsModule } from '../tls/tls.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

/** Device pairing and management (AUTH-007 to AUTH-009). */
@Module({
  imports: [AuthModule, TlsModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
