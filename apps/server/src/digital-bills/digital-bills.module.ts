import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CloudModule } from '../cloud/cloud.module.js';
import { EventsModule } from '../events/events.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DigitalBillsController } from './digital-bills.controller.js';
import {
  DEFAULT_DIGITAL_BILL_OPTIONS,
  DIGITAL_BILL_OPTIONS,
  DigitalBillsService,
} from './digital-bills.service.js';

/** Digital bills on WhatsApp or SMS, through the vendor's Control Plane (BILL-012, P7-09b). */
@Module({
  imports: [AuthModule, CloudModule, EventsModule, SettingsModule],
  controllers: [DigitalBillsController],
  providers: [
    DigitalBillsService,
    { provide: DIGITAL_BILL_OPTIONS, useValue: DEFAULT_DIGITAL_BILL_OPTIONS },
  ],
  exports: [DigitalBillsService],
})
export class DigitalBillsModule {}
