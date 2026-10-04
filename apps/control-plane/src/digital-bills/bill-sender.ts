import type { DigitalBillChannel } from '@rp/contracts/control-plane';
import type { CpConfig } from '../config/cp-config.js';

/**
 * Who sends digital bills (BILL-012, P7-09a): one adapter per channel, each the vendor's provider
 * account. WhatsApp first (OI-06); SMS takes the same shape once the vendor has a provider with
 * TRAI DLT registration (manual task 28). Tests provide their own.
 */
export const BILL_SENDERS = Symbol('BILL_SENDERS');

/** What the message says: the template's parameters, in this order. */
export interface BillMessage {
  /** +91 and ten digits. */
  readonly phone: string;
  readonly restaurantName: string;
  readonly invoiceNumber: string;
  /** `₹1,234.00`. */
  readonly amount: string;
  readonly link: string;
  /** `04-11-2026`: when the link stops working. */
  readonly expiresOn: string;
}

export type BillSendErrorCode = 'PROVIDER_FAILED' | 'NUMBER_REJECTED';

/** Why a message was not sent; `retryable` when trying again later may work. */
export class BillSendError extends Error {
  constructor(
    readonly code: BillSendErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BillSendError';
  }
}

export interface BillSender {
  readonly channel: DigitalBillChannel;
  /** Sends one message; resolves with the provider's id for it. */
  send(message: BillMessage): Promise<{ readonly providerMessageId: string }>;
}

export type BillSenders = Partial<Readonly<Record<DigitalBillChannel, BillSender>>>;

export interface WhatsAppOptions {
  readonly token: string;
  readonly phoneNumberId: string;
  readonly template: string;
  readonly language: string;
  /** `https://graph.facebook.com/v21.0`; another address only for a proxy or a test double. */
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** Meta's error codes that mean this number cannot get the message, so trying again is useless. */
const NUMBER_ERRORS = new Set([131026, 131030, 131045, 131047, 131050, 131051, 1006]);

interface GraphAnswer {
  readonly messages?: readonly { readonly id?: unknown }[];
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/**
 * WhatsApp through Meta's Cloud API: a template message (the only kind a business may start a
 * conversation with) whose body takes the restaurant, the invoice number, the amount, the link
 * and the day the link expires.
 */
export class WhatsAppCloudSender implements BillSender {
  readonly channel = 'WHATSAPP' as const;

  constructor(private readonly options: WhatsAppOptions) {}

  async send(message: BillMessage): Promise<{ readonly providerMessageId: string }> {
    const { options } = this;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // The Cloud API takes the number with its country code and no plus.
      to: message.phone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: options.template,
        language: { code: options.language },
        components: [
          {
            type: 'body',
            parameters: [
              message.restaurantName,
              message.invoiceNumber,
              message.amount,
              message.link,
              message.expiresOn,
            ].map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        `${options.apiUrl}/${options.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
    } catch (error) {
      throw new BillSendError(
        'PROVIDER_FAILED',
        `WhatsApp could not be reached (${error instanceof Error ? error.message : String(error)}).`,
        true,
      );
    }
    let answer: GraphAnswer = {};
    try {
      answer = (await response.json()) as GraphAnswer;
    } catch {
      // An answer that is not JSON is judged by its status alone.
    }
    const id = answer.messages?.[0]?.id;
    if (response.ok && typeof id === 'string') return { providerMessageId: id };
    const code = typeof answer.error?.code === 'number' ? answer.error.code : undefined;
    const said = typeof answer.error?.message === 'string' ? `: ${answer.error.message}` : '';
    if (code !== undefined && NUMBER_ERRORS.has(code)) {
      throw new BillSendError(
        'NUMBER_REJECTED',
        `WhatsApp cannot deliver to this number (${String(code)}${said}).`,
        false,
      );
    }
    // Busy, rate-limited or down: later may work. Anything else is the vendor's set-up to fix.
    const retryable = response.status === 429 || response.status >= 500;
    throw new BillSendError(
      'PROVIDER_FAILED',
      `WhatsApp refused the message (HTTP ${String(response.status)}${code === undefined ? '' : `, ${String(code)}`}${said}).`,
      retryable,
    );
  }
}

/** The channels the vendor has set up (SEC-002: their keys live only in the secret manager). */
export function billSendersFor(config: CpConfig): BillSenders {
  if (
    config.whatsappToken === undefined ||
    config.whatsappPhoneNumberId === undefined ||
    config.publicUrl === undefined ||
    config.digitalBillKey === undefined
  ) {
    return {};
  }
  return {
    WHATSAPP: new WhatsAppCloudSender({
      token: config.whatsappToken,
      phoneNumberId: config.whatsappPhoneNumberId,
      template: config.whatsappTemplate,
      language: config.whatsappLanguage,
      apiUrl: config.whatsappApiUrl,
      timeoutMs: 15_000,
    }),
  };
}
