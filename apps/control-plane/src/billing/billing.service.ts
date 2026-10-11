import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  type BillingCycle,
  type BillingRunView,
  CYCLE_MONTHS,
  DeviceLimits,
  type LicenceModule,
  type PlanRequest,
  type PlanView,
  type RecordPaymentRequest,
  type SubscriptionRequest,
  type SubscriptionView,
  type VendorInvoiceView,
} from '@rp/contracts/control-plane';
import {
  addDays,
  addMonths,
  billingLicenceState,
  billingPeriod,
  calendarDateOf,
  daysBetween,
  financialYearOf,
  overdueStage,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { lockFor } from '../database/advisory-lock.js';
import { CpError } from '../errors/cp-error.js';
import type {
  Plan,
  Subscription,
  VendorInvoice,
  VendorPayment,
} from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { LicencesService } from '../licences/licences.service.js';

const DAY_MS = 86_400_000;
/** The billing run's actor in the audit trail. */
const BILLING_ACTOR = 'system:billing';

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

function priceFor(plan: Plan, cycle: BillingCycle): number | null {
  if (cycle === 'MONTHLY') return plan.monthlyPrice;
  if (cycle === 'QUARTERLY') return plan.quarterlyPrice;
  return plan.yearlyPrice;
}

function planView(plan: Plan & { _count?: { subscriptions: number } }): PlanView {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    prices: {
      MONTHLY: plan.monthlyPrice,
      QUARTERLY: plan.quarterlyPrice,
      YEARLY: plan.yearlyPrice,
    },
    deviceLimits: DeviceLimits.parse(plan.deviceLimits),
    modules: plan.modules as LicenceModule[],
    archivedAt: plan.archivedAt?.toISOString() ?? null,
    subscribers: plan._count?.subscriptions ?? 0,
  };
}

function subscriptionView(subscription: Subscription & { plan: Plan }): SubscriptionView {
  return {
    tenantId: subscription.tenantId,
    planId: subscription.planId,
    planName: subscription.plan.name,
    cycle: subscription.cycle,
    price: subscription.price,
    startedOn: isoDate(subscription.startedOn),
    nextInvoiceOn: isoDate(subscription.nextInvoiceOn),
    cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
  };
}

function invoiceView(
  invoice: VendorInvoice & { payments: VendorPayment[]; tenant: { name: string } },
  today: string,
): VendorInvoiceView {
  const due = isoDate(invoice.dueOn);
  return {
    id: invoice.id,
    tenantId: invoice.tenantId,
    tenantName: invoice.tenant.name,
    number: invoice.number,
    periodStart: isoDate(invoice.periodStart),
    periodEnd: isoDate(invoice.periodEnd),
    amount: invoice.amount,
    paid: invoice.payments.reduce((total, payment) => total + payment.amount, 0),
    dueOn: due,
    status: invoice.status,
    daysOverdue: invoice.status === 'ISSUED' ? Math.max(0, daysBetween(due, today)) : 0,
    issuedAt: invoice.issuedAt.toISOString(),
    paidAt: invoice.paidAt?.toISOString() ?? null,
    voidReason: invoice.voidReason,
  };
}

const INVOICE_INCLUDE = { payments: true, tenant: { select: { name: true } } } as const;

function notFound(what: string): CpError {
  return new CpError(404, 'NOT_FOUND', `${what} was not found.`);
}

/**
 * Subscriptions (VCP-003, P7-02c): the plan catalogue, each restaurant's plan and cycle, the
 * vendor's invoices and the payments recorded by hand (v1). The billing run (hourly, and on
 * demand) issues the invoices that are due and moves the licences of restaurants behind on
 * payment along LIC-005: payment due once an invoice is past due, grace after the agreed days,
 * restricted when grace is over. A payment lifts what billing did at once, so an online
 * restaurant is active again within a minute (LIC-006); a vendor's own decision is never undone.
 */
@Injectable()
export class BillingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BillingService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly licences: LicencesService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.billingIntervalMinutes === 0) return;
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
        this.logger.error({ err: error }, 'The billing run failed');
      });
    }, this.config.billingIntervalMinutes * 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- plans

  async plans(): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      orderBy: { code: 'asc' },
      include: { _count: { select: { subscriptions: { where: { cancelledAt: null } } } } },
    });
    return plans.map(planView);
  }

  async createPlan(request: PlanRequest, actor: string): Promise<PlanView> {
    if ((await this.prisma.plan.findUnique({ where: { code: request.code } })) !== null) {
      throw new CpError(409, 'PLAN_CODE_TAKEN', 'A plan has that code.');
    }
    return this.prisma.transaction(async (tx) => {
      const plan = await tx.plan.create({ data: { id: newId(), ...this.planColumns(request) } });
      await this.audit.record(tx, {
        actor,
        action: 'plan.created',
        targetType: 'plan',
        targetId: plan.id,
        details: { ...request },
      });
      return planView(plan);
    });
  }

  /** Prices apply to invoices from now on; limits and modules reach subscribers' licences. */
  async updatePlan(id: string, request: PlanRequest, actor: string): Promise<PlanView> {
    const plan = await this.prisma.transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id } });
      if (before === null) throw notFound('The plan');
      const updated = await tx.plan.update({ where: { id }, data: this.planColumns(request) });
      await this.audit.record(tx, {
        actor,
        action: 'plan.changed',
        targetType: 'plan',
        targetId: id,
        details: { before: planView(before), after: { ...request } },
      });
      return updated;
    });
    const subscribers = await this.prisma.subscription.findMany({
      where: { planId: id, cancelledAt: null },
      select: { tenantId: true },
    });
    for (const { tenantId } of subscribers) {
      await this.applyPlan(tenantId, plan, `Plan ${plan.name} changed`, actor);
    }
    return (await this.plans()).find((entry) => entry.id === id) ?? planView(plan);
  }

  async archivePlan(id: string, reason: string, actor: string): Promise<PlanView> {
    return this.prisma.transaction(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { id } });
      if (plan === null) throw notFound('The plan');
      const archived = await tx.plan.update({
        where: { id },
        data: { archivedAt: plan.archivedAt ?? new Date() },
      });
      await this.audit.record(tx, {
        actor,
        action: 'plan.archived',
        targetType: 'plan',
        targetId: id,
        details: { reason },
      });
      return planView(archived);
    });
  }

  // ---------------------------------------------------------------- subscriptions

  async subscription(tenantId: string): Promise<SubscriptionView> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (subscription === null) throw notFound('The subscription');
    return subscriptionView(subscription);
  }

  /**
   * Puts a restaurant on a plan and cycle (VCP-003). A new subscription is first invoiced on
   * `startsOn`; a change keeps the next invoice date and applies the new price from it. The
   * plan's limits and modules reach the restaurant's licences at their next heartbeat.
   */
  async setSubscription(
    tenantId: string,
    request: SubscriptionRequest,
    actor: string,
  ): Promise<SubscriptionView> {
    const plan = await this.prisma.plan.findUnique({ where: { id: request.planId } });
    if (plan === null) throw notFound('The plan');
    if (plan.archivedAt !== null) {
      throw new CpError(409, 'PLAN_ARCHIVED', 'This plan is no longer offered.');
    }
    const price = priceFor(plan, request.cycle);
    if (price === null) {
      throw new CpError(409, 'CYCLE_NOT_OFFERED', `${plan.name} is not offered on that cycle.`);
    }
    const subscription = await this.prisma.transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (tenant === null) throw notFound('The tenant');
      const before = await tx.subscription.findUnique({ where: { tenantId } });
      const saved = await tx.subscription.upsert({
        where: { tenantId },
        create: {
          tenantId,
          planId: plan.id,
          cycle: request.cycle,
          price,
          startedOn: dbDate(request.startsOn),
          nextInvoiceOn: dbDate(request.startsOn),
        },
        update: { planId: plan.id, cycle: request.cycle, price, cancelledAt: null },
        include: { plan: true },
      });
      await this.audit.record(tx, {
        actor,
        action: 'subscription.set',
        targetType: 'tenant',
        targetId: tenantId,
        details: {
          reason: request.reason,
          before:
            before === null
              ? null
              : { planId: before.planId, cycle: before.cycle, price: before.price },
          after: { planId: plan.id, cycle: request.cycle, price },
        },
      });
      return saved;
    });
    await this.applyPlan(tenantId, plan, request.reason, actor);
    return subscriptionView(subscription);
  }

  // ---------------------------------------------------------------- invoices and payments

  async invoices(filter: {
    readonly tenantId?: string | undefined;
    readonly status?: 'ISSUED' | 'PAID' | 'VOID' | 'OVERDUE' | undefined;
  }): Promise<VendorInvoiceView[]> {
    const today = calendarDateOf(new Date());
    const invoices = await this.prisma.vendorInvoice.findMany({
      where: {
        ...(filter.tenantId !== undefined && { tenantId: filter.tenantId }),
        ...(filter.status === 'OVERDUE'
          ? { status: 'ISSUED', dueOn: { lt: dbDate(today) } }
          : filter.status !== undefined && { status: filter.status }),
      },
      orderBy: [{ issuedAt: 'desc' }],
      include: INVOICE_INCLUDE,
    });
    return invoices.map((invoice) => invoiceView(invoice, today));
  }

  /** A payment received (v1: by hand); once nothing is overdue, licences are active again. */
  async recordPayment(
    invoiceId: string,
    payment: RecordPaymentRequest,
    actor: string,
    now = new Date(),
  ): Promise<VendorInvoiceView> {
    const invoice = await this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM vendor_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const current = await tx.vendorInvoice.findUnique({
        where: { id: invoiceId },
        include: INVOICE_INCLUDE,
      });
      if (current === null) throw notFound('The invoice');
      if (current.status !== 'ISSUED') {
        throw new CpError(
          409,
          'INVOICE_CLOSED',
          `This invoice is ${current.status.toLowerCase()}.`,
        );
      }
      const paid = current.payments.reduce((total, entry) => total + entry.amount, 0);
      if (paid + payment.amount > current.amount) {
        throw new CpError(409, 'OVERPAYMENT', 'That is more than is due on this invoice.', {
          due: current.amount - paid,
        });
      }
      await tx.vendorPayment.create({
        data: {
          id: newId(),
          invoiceId,
          amount: payment.amount,
          mode: payment.mode,
          reference: payment.reference,
          receivedOn: dbDate(payment.receivedOn),
          recordedBy: actor,
        },
      });
      const settled = paid + payment.amount === current.amount;
      await tx.vendorInvoice.update({
        where: { id: invoiceId },
        data: settled ? { status: 'PAID', paidAt: new Date() } : {},
      });
      await this.audit.record(tx, {
        actor,
        action: settled ? 'invoice.paid' : 'invoice.payment_recorded',
        targetType: 'vendor_invoice',
        targetId: invoiceId,
        details: { ...payment, settled },
      });
      return tx.vendorInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: INVOICE_INCLUDE,
      });
    });
    // LIC-006: within a minute, while online.
    await this.followUp(invoice.tenantId, now);
    return invoiceView(invoice, calendarDateOf(now));
  }

  async voidInvoice(
    invoiceId: string,
    reason: string,
    actor: string,
    now = new Date(),
  ): Promise<VendorInvoiceView> {
    const invoice = await this.prisma.transaction(async (tx) => {
      const current = await tx.vendorInvoice.findUnique({ where: { id: invoiceId } });
      if (current === null) throw notFound('The invoice');
      if (current.status !== 'ISSUED') {
        throw new CpError(
          409,
          'INVOICE_CLOSED',
          `This invoice is ${current.status.toLowerCase()}.`,
        );
      }
      const voided = await tx.vendorInvoice.update({
        where: { id: invoiceId },
        data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
        include: INVOICE_INCLUDE,
      });
      await this.audit.record(tx, {
        actor,
        action: 'invoice.voided',
        targetType: 'vendor_invoice',
        targetId: invoiceId,
        details: { reason },
      });
      return voided;
    });
    await this.followUp(invoice.tenantId, now);
    return invoiceView(invoice, calendarDateOf(now));
  }

  // ---------------------------------------------------------------- the billing run

  /** Issues the invoices that are due and follows up every restaurant's overdue ones. */
  async run(now = new Date()): Promise<BillingRunView> {
    const today = calendarDateOf(now);
    let issued = 0;
    const due = await this.prisma.subscription.findMany({
      where: { cancelledAt: null, nextInvoiceOn: { lte: dbDate(today) } },
      select: { tenantId: true },
    });
    for (const { tenantId } of due) issued += await this.issueDue(tenantId, today);
    const counts = { paymentDue: 0, grace: 0, restricted: 0 };
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      const moved = await this.followUp(tenant.id, now);
      counts.paymentDue += moved.PAYMENT_DUE;
      counts.grace += moved.GRACE;
      counts.restricted += moved.RESTRICTED;
    }
    return { issued, ...counts };
  }

  /** Every invoice a subscription owes up to today (catching up if the run was not running). */
  private async issueDue(tenantId: string, today: string): Promise<number> {
    return this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM subscriptions WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const subscription = await tx.subscription.findUniqueOrThrow({ where: { tenantId } });
      let next = isoDate(subscription.nextInvoiceOn);
      let issued = 0;
      while (subscription.cancelledAt === null && next <= today) {
        const months = CYCLE_MONTHS[subscription.cycle];
        const period = billingPeriod(next, months);
        const number = await this.nextNumber(tx, next);
        const invoice = await tx.vendorInvoice.create({
          data: {
            id: newId(),
            tenantId,
            number,
            periodStart: dbDate(period.start),
            periodEnd: dbDate(period.end),
            amount: subscription.price,
            dueOn: dbDate(addDays(next, this.config.billingPaymentTermsDays)),
          },
        });
        await this.audit.record(tx, {
          actor: BILLING_ACTOR,
          action: 'invoice.issued',
          targetType: 'vendor_invoice',
          targetId: invoice.id,
          details: { tenantId, number, amount: invoice.amount, period },
        });
        next = addMonths(next, months);
        issued += 1;
      }
      await tx.subscription.update({ where: { tenantId }, data: { nextInvoiceOn: dbDate(next) } });
      return issued;
    });
  }

  /** `SUB/2026-27/00001`: sequential per financial year of the period's start. */
  private async nextNumber(tx: TransactionClient, periodStart: string): Promise<string> {
    const year = financialYearOf(periodStart).label;
    const prefix = `SUB/${year}/`;
    await lockFor(tx, prefix);
    const count = await tx.vendorInvoice.count({ where: { number: { startsWith: prefix } } });
    return `${prefix}${String(count + 1).padStart(5, '0')}`;
  }

  /**
   * Moves a restaurant's licences along LIC-005 for its oldest unpaid invoice, or back to active
   * once nothing is overdue (only what billing itself did). Returns how many moved to each state.
   */
  private async followUp(
    tenantId: string,
    now: Date,
  ): Promise<Record<'ACTIVE' | 'PAYMENT_DUE' | 'GRACE' | 'RESTRICTED', number>> {
    const today = calendarDateOf(now);
    const counts = { ACTIVE: 0, PAYMENT_DUE: 0, GRACE: 0, RESTRICTED: 0 };
    const oldest = await this.prisma.vendorInvoice.findFirst({
      where: { tenantId, status: 'ISSUED', dueOn: { lt: dbDate(today) } },
      orderBy: { dueOn: 'asc' },
    });
    const stage = overdueStage(
      oldest === null ? undefined : isoDate(oldest.dueOn),
      today,
      this.config.billingGraceAfterDays,
    );
    const licences = await this.prisma.installationLicence.findMany({
      where: { installation: { tenantId, status: { not: 'REVOKED' } } },
    });
    for (const licence of licences) {
      let current = licence.state;
      let setByBilling = licence.setByBilling;
      let graceStartedAt = licence.graceStartedAt;
      // Each step is one LIC-005 transition; a few settle any change of stage.
      for (let step = 0; step < 3; step += 1) {
        const graceOver =
          graceStartedAt !== null &&
          graceStartedAt.getTime() + licence.graceDays * DAY_MS <= now.getTime();
        const target = billingLicenceState({ current, setByBilling, stage, graceOver });
        if (target === undefined || target === current) break;
        const reason =
          target === 'ACTIVE'
            ? 'Payment received'
            : `Invoice ${oldest?.number ?? ''} unpaid since ${oldest === null ? '' : isoDate(oldest.dueOn)}`;
        const summary = await this.licences.change(
          licence.installationId,
          { state: target, reason },
          BILLING_ACTOR,
          now,
          { byBilling: true },
        );
        current = summary.state;
        setByBilling = true;
        graceStartedAt = summary.graceStartedAt;
        counts[target as keyof typeof counts] += 1;
      }
    }
    return counts;
  }

  /** The plan's name, limits and modules on every licence of the restaurant. */
  private async applyPlan(tenantId: string, plan: Plan, reason: string, actor: string) {
    const installations = await this.prisma.installation.findMany({
      where: { tenantId, status: { not: 'REVOKED' } },
      select: { id: true },
    });
    for (const installation of installations) {
      await this.licences.change(
        installation.id,
        {
          reason,
          plan: plan.name,
          deviceLimits: DeviceLimits.parse(plan.deviceLimits),
          modules: plan.modules as LicenceModule[],
        },
        actor,
      );
    }
  }

  private planColumns(request: PlanRequest) {
    return {
      code: request.code,
      name: request.name,
      monthlyPrice: request.prices.MONTHLY,
      quarterlyPrice: request.prices.QUARTERLY,
      yearlyPrice: request.prices.YEARLY,
      deviceLimits: { ...request.deviceLimits },
      modules: [...request.modules],
    };
  }
}
