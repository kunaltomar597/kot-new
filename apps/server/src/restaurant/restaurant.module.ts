import { Module } from '@nestjs/common';
import { InvoiceSeriesService } from './invoice-series.service.js';
import {
  InvoiceSeriesController,
  RestaurantController,
  TaxGroupsController,
} from './restaurant.controller.js';
import { RestaurantService } from './restaurant.service.js';
import { TaxGroupsService } from './tax-groups.service.js';

/** The restaurant's setup (P1-01b): profile, invoice particulars, tax groups, invoice series. */
@Module({
  controllers: [RestaurantController, TaxGroupsController, InvoiceSeriesController],
  providers: [RestaurantService, TaxGroupsService, InvoiceSeriesService],
  exports: [RestaurantService, TaxGroupsService, InvoiceSeriesService],
})
export class RestaurantModule {}
