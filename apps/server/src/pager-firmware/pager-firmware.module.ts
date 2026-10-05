import { Module } from '@nestjs/common';
import { CloudModule } from '../cloud/cloud.module.js';
import { PagersModule } from '../pagers/pagers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TlsModule } from '../tls/tls.module.js';
import {
  PagerFirmwareController,
  PagerFirmwareDownloadController,
} from './pager-firmware.controller.js';
import {
  DEFAULT_PAGER_FIRMWARE_OPTIONS,
  PAGER_FIRMWARE_OPTIONS,
  PagerFirmwareService,
} from './pager-firmware.service.js';

/**
 * Pager firmware over the air through the restaurant PC (PGR-011, P2-04b): the vendor's signed
 * release fetched and checked, offered to free pagers over MQTT and downloaded from this PC.
 */
@Module({
  imports: [CloudModule, PagersModule, SettingsModule, TlsModule],
  controllers: [PagerFirmwareController, PagerFirmwareDownloadController],
  providers: [
    PagerFirmwareService,
    { provide: PAGER_FIRMWARE_OPTIONS, useValue: DEFAULT_PAGER_FIRMWARE_OPTIONS },
  ],
  exports: [PagerFirmwareService],
})
export class PagerFirmwareModule {}
