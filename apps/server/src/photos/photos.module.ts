import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { PhotosController } from './photos.controller.js';
import { PhotosService } from './photos.service.js';

/** Photos for menu items, the logo and staff (P1-04). */
@Module({
  imports: [SettingsModule],
  controllers: [PhotosController],
  providers: [PhotosService],
  exports: [PhotosService],
})
export class PhotosModule {}
