import { createHash, createHmac } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { DigitalBillRequest, DigitalBillView } from '@rp/contracts/control-plane';
import { calendarDateOf, formatDisplayDate, formatRupees, maskPhone } from '@rp/domain';
import { z } from 'zod';
import type { AuthenticatedInstallation } from '../auth/installation.guard.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { DigitalBill } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { billPage, goneBillPage, unknownBillPage } from './bill-page.js';
import { BILL_SENDERS, BillSendError, type BillSenders } from './bill-sender.js';

const DAY_MS = 86_400_000;
/** Bill pages one address may open in a minute: plenty for a diner, too few to guess links. */
const PAGES_PER_MINUTE = 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const Lines = z.array(z.string());

export interface BillPageAnswer {
  readonly status: 200 | 404 | 410 | 429;
  readonly html: string;
}

/**
 * Digital bills at the Control Plane (BILL-012, P7-09a). A restaurant PC asks, having checked the
 * diner's consent; the bill as printed is kept behind a link derived from `CP_DIGITAL_BILL_KEY`
 * (only its hash is stored) and the message goes through the vendor's provider. Each send is the
 * PC's id: asked again, a sent bill answers with the first result and a failed one is tried again.
 * Expired copies are deleted; only the number's last four digits are ever stored.
 */
@Injectable()
export class DigitalBillsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DigitalBillsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    @Inject(BILL_SENDERS) private readonly senders: BillSenders,
    private readonly limiter: RateLimiter,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.digitalBillSweepSeconds === 0) return;
    this.timer = setInterval(() => {
      void this.purge().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Deleting expired digital bills failed');
      });
    }, this.config.digitalBillSweepSeconds * 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** The link's secret part for a bill, derived so that it is never stored. */
  private tokenFor(id: string): string {
    const key = Buffer.from(this.config.digitalBillKey ?? '', 'base64');
    return createHmac('sha256', key).update(`rp-digital-bill:${id}`).digest('base64url');
  }

  private static hashOf(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private linkFor(id: string): string {
    return `${(this.config.publicUrl ?? '').replace(/\/$/, '')}/v1/bills/${this.tokenFor(id)}`;
  }

  private view(bill: DigitalBill): DigitalBillView {
    const sent = bill.status === 'SENT';
    return {
      id: bill.requestId,
      channel: bill.channel === 'SMS' ? 'SMS' : 'WHATSAPP',
      phone: bill.phoneMasked,
      status: sent ? 'SENT' : 'FAILED',
      link: bill.lines === null ? null : this.linkFor(bill.id),
      expiresAt: bill.expiresAt.toISOString(),
      sentAt: bill.sentAt?.toISOString() ?? null,
      error: sent ? null : (bill.error ?? 'It was not sent.'),
      retryable: !sent && bill.retryable,
    };
  }

  async send(
    installation: AuthenticatedInstallation,
    request: DigitalBillRequest,
  ): Promise<DigitalBillView> {
    const sender = this.senders[request.channel];
    if (
      sender === undefined ||
      this.config.publicUrl === undefined ||
      this.config.digitalBillKey === undefined
    ) {
      throw new CpError(
        503,
        'DIGITAL_BILLS_NOT_SET_UP',
        `Bills by ${request.channel === 'SMS' ? 'SMS' : 'WhatsApp'} are not set up by the vendor yet.`,
      );
    }
    const where = {
      installationId_requestId: { installationId: installation.id, requestId: request.id },
    };
    const existing = await this.prisma.digitalBill.findUnique({ where });
    if (existing?.status === 'SENT') return this.view(existing);

    const now = new Date();
    if (existing === null) {
      const today = await this.prisma.digitalBill.count({
        where: {
          installationId: installation.id,
          createdAt: { gt: new Date(now.getTime() - DAY_MS) },
        },
      });
      if (today >= this.config.digitalBillDailyLimit) {
        throw new CpError(
          429,
          'DIGITAL_BILL_LIMIT',
          'This restaurant has sent as many digital bills as it may today. Try again tomorrow.',
        );
      }
    }
    const id = existing?.id ?? newId();
    const expiresAt = existing?.expiresAt ?? new Date(now.getTime() + request.keepDays * DAY_MS);
    // Kept before it is sent, so the link opens the moment the message arrives.
    const bill =
      existing === null
        ? await this.prisma.digitalBill.create({
            data: {
              id,
              installationId: installation.id,
              requestId: request.id,
              channel: request.channel,
              phoneMasked: maskPhone(request.phone),
              tokenHash: DigitalBillsService.hashOf(this.tokenFor(id)),
              restaurantName: request.restaurantName,
              invoiceNumber: request.invoiceNumber,
              invoiceDate: new Date(request.invoiceDate),
              grandTotal: request.grandTotal,
              lines: request.lines,
              expiresAt,
              status: 'FAILED',
              error: 'Being sent.',
              retryable: true,
            },
          })
        : await this.prisma.digitalBill.update({
            where: { id },
            data: { attempts: { increment: 1 }, lines: request.lines },
          });

    try {
      const { providerMessageId } = await sender.send({
        phone: request.phone,
        restaurantName: request.restaurantName,
        invoiceNumber: request.invoiceNumber,
        amount: formatRupees(request.grandTotal),
        link: this.linkFor(id),
        expiresOn: formatDisplayDate(calendarDateOf(expiresAt)),
      });
      return this.view(
        await this.prisma.digitalBill.update({
          where: { id: bill.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            providerMessageId,
            error: null,
            retryable: false,
          },
        }),
      );
    } catch (error) {
      const known = error instanceof BillSendError ? error : undefined;
      if (known === undefined) this.logger.error({ err: error }, 'Sending a digital bill failed');
      return this.view(
        await this.prisma.digitalBill.update({
          where: { id: bill.id },
          data: {
            status: 'FAILED',
            error: (known?.message ?? 'The provider could not be asked.').slice(0, 300),
            retryable: known?.retryable ?? true,
          },
        }),
      );
    }
  }

  /** The page behind a link, for whoever opens it (the token is the credential). */
  async page(token: string, address: string, now = new Date()): Promise<BillPageAnswer> {
    if (!this.limiter.hit(`bill-page:${address}`, PAGES_PER_MINUTE, 60_000, now.getTime())) {
      return { status: 429, html: unknownBillPage() };
    }
    if (!TOKEN.test(token)) return { status: 404, html: unknownBillPage() };
    const bill = await this.prisma.digitalBill.findUnique({
      where: { tokenHash: DigitalBillsService.hashOf(token) },
    });
    if (bill === null) return { status: 404, html: unknownBillPage() };
    const lines = Lines.safeParse(bill.lines);
    if (!lines.success || bill.expiresAt <= now) return { status: 410, html: goneBillPage() };
    return {
      status: 200,
      html: billPage({
        restaurantName: bill.restaurantName,
        invoiceNumber: bill.invoiceNumber,
        lines: lines.data,
        expiresOn: formatDisplayDate(calendarDateOf(bill.expiresAt)),
      }),
    };
  }

  /** Deletes the copies of bills whose links have expired; returns how many. */
  purge(now = new Date()): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE digital_bills SET lines = NULL, purged_at = ${now}
      WHERE expires_at <= ${now} AND lines IS NOT NULL`;
  }
}
