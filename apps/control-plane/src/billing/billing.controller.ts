import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  type BillingRunView,
  InvoiceQuery,
  type PlanListResponse,
  PlanParams,
  PlanRequest,
  type PlanView,
  RecordPaymentRequest,
  SubscriptionRequest,
  type SubscriptionView,
  type VendorInvoiceListResponse,
  VendorInvoiceParams,
  type VendorInvoiceView,
  VendorTenantParams,
  VoidInvoiceRequest,
} from '@rp/contracts/control-plane';
import { ZodPipe } from '../http/zod.pipe.js';
import { Vendor, type VendorRequest, vendorOf } from '../vendor/vendor.guard.js';
import { BillingService } from './billing.service.js';

/** Plans, subscriptions, the vendor's invoices and payments for vendor staff (VCP-003). */
@Controller('vendor')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @Vendor('FLEET_VIEW')
  async plans(): Promise<PlanListResponse> {
    return { plans: await this.billing.plans() };
  }

  @Post('plans')
  @Vendor('BILLING_MANAGE')
  createPlan(
    @Req() request: VendorRequest,
    @Body(new ZodPipe(PlanRequest)) body: PlanRequest,
  ): Promise<PlanView> {
    return this.billing.createPlan(body, vendorOf(request).actor);
  }

  @Put('plans/:id')
  @Vendor('BILLING_MANAGE')
  updatePlan(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(PlanParams)) params: PlanParams,
    @Body(new ZodPipe(PlanRequest)) body: PlanRequest,
  ): Promise<PlanView> {
    return this.billing.updatePlan(params.id, body, vendorOf(request).actor);
  }

  @Post('plans/:id/archive')
  @HttpCode(200)
  @Vendor('BILLING_MANAGE')
  archivePlan(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(PlanParams)) params: PlanParams,
    @Body(new ZodPipe(VoidInvoiceRequest)) body: VoidInvoiceRequest,
  ): Promise<PlanView> {
    return this.billing.archivePlan(params.id, body.reason, vendorOf(request).actor);
  }

  @Get('tenants/:id/subscription')
  @Vendor('FLEET_VIEW')
  subscription(
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
  ): Promise<SubscriptionView> {
    return this.billing.subscription(params.id);
  }

  @Put('tenants/:id/subscription')
  @Vendor('BILLING_MANAGE')
  setSubscription(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
    @Body(new ZodPipe(SubscriptionRequest)) body: SubscriptionRequest,
  ): Promise<SubscriptionView> {
    return this.billing.setSubscription(params.id, body, vendorOf(request).actor);
  }

  @Get('invoices')
  @Vendor('FLEET_VIEW')
  async invoices(
    @Query(new ZodPipe(InvoiceQuery)) query: InvoiceQuery,
  ): Promise<VendorInvoiceListResponse> {
    return { invoices: await this.billing.invoices(query) };
  }

  @Post('invoices/:id/payments')
  @HttpCode(200)
  @Vendor('BILLING_MANAGE')
  recordPayment(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInvoiceParams)) params: VendorInvoiceParams,
    @Body(new ZodPipe(RecordPaymentRequest)) body: RecordPaymentRequest,
  ): Promise<VendorInvoiceView> {
    return this.billing.recordPayment(params.id, body, vendorOf(request).actor);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @Vendor('BILLING_MANAGE')
  voidInvoice(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInvoiceParams)) params: VendorInvoiceParams,
    @Body(new ZodPipe(VoidInvoiceRequest)) body: VoidInvoiceRequest,
  ): Promise<VendorInvoiceView> {
    return this.billing.voidInvoice(params.id, body.reason, vendorOf(request).actor);
  }

  @Post('billing/run')
  @HttpCode(200)
  @Vendor('BILLING_MANAGE')
  run(): Promise<BillingRunView> {
    return this.billing.run();
  }
}
