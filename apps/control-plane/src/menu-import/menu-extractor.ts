import type { MenuDraft } from '@rp/contracts/control-plane';
import {
  draftFromReading,
  READING_SYSTEM_PROMPT,
  RECORD_MENU_SCHEMA,
  RECORD_MENU_TOOL,
} from './menu-reading.js';

/** Reads printed menus (ONB-006). Tests provide their own; production uses the AI provider. */
export const MENU_EXTRACTOR = Symbol('MENU_EXTRACTOR');

export interface ExtractionFile {
  readonly name: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface ExtractionOutput {
  readonly draft: MenuDraft;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type ExtractionErrorCode = 'AI_PROVIDER_FAILED' | 'AI_NO_MENU_FOUND';

/** Why reading failed: `retryable` when trying again later may work (overloaded, timed out). */
export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface MenuExtractor {
  /** False when no AI provider is set up: imports are refused (AI_IMPORT_UNAVAILABLE). */
  readonly configured: boolean;
  extract(files: readonly ExtractionFile[]): Promise<ExtractionOutput>;
}

/** Without a key: AI import is off (SEC-002: the key lives only in the vendor's secret store). */
export const NO_MENU_EXTRACTOR: MenuExtractor = {
  configured: false,
  extract: () =>
    Promise.reject(new ExtractionError('AI_PROVIDER_FAILED', 'AI import is not set up.', false)),
};

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model: string;
  /** `https://api.anthropic.com`; another address only for a proxy or a test double. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** A long menu needs room: about 60 tokens a dish, 500 dishes. */
const MAX_OUTPUT_TOKENS = 32_000;
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const INSTRUCTION =
  'These are photos or pages of one restaurant menu. Record it with the record_menu tool.';

interface MessagesResponse {
  readonly model?: unknown;
  readonly stop_reason?: unknown;
  readonly content?: readonly {
    readonly type?: unknown;
    readonly name?: unknown;
    readonly input?: unknown;
  }[];
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
}

/**
 * The Anthropic Messages API (Claude reads images and PDFs): one request with every file and a
 * forced call of the `record_menu` tool, so the answer is structured data, checked again here.
 */
export class AnthropicMenuExtractor implements MenuExtractor {
  readonly configured = true;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** The request body, separate so tests can check what is sent. */
  requestBody(files: readonly ExtractionFile[]): Record<string, unknown> {
    const encode = (content: Uint8Array) => Buffer.from(content).toString('base64');
    return {
      model: this.options.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: READING_SYSTEM_PROMPT,
      tools: [
        {
          name: RECORD_MENU_TOOL,
          description: 'Record every section, dish, price, size and add-on of the menu.',
          input_schema: RECORD_MENU_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: RECORD_MENU_TOOL },
      messages: [
        {
          role: 'user',
          content: [
            ...files.map((file) =>
              file.contentType === 'application/pdf'
                ? {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: encode(file.content),
                    },
                  }
                : {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: file.contentType,
                      data: encode(file.content),
                    },
                  },
            ),
            { type: 'text', text: INSTRUCTION },
          ],
        },
      ],
    };
  }

  async extract(files: readonly ExtractionFile[]): Promise<ExtractionOutput> {
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(this.requestBody(files)),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new ExtractionError(
        'AI_PROVIDER_FAILED',
        'The menu reader did not answer in time. Try again in a few minutes.',
        true,
      );
    }
    if (!response.ok) {
      const retryable = RETRYABLE_STATUSES.has(response.status);
      throw new ExtractionError(
        'AI_PROVIDER_FAILED',
        retryable
          ? 'The menu reader is busy. Try again in a few minutes.'
          : 'The menu reader could not take these files. Try clearer photos or a PDF.',
        retryable,
      );
    }
    const body = (await response.json()) as MessagesResponse;
    if (body.stop_reason === 'max_tokens') {
      throw new ExtractionError(
        'AI_PROVIDER_FAILED',
        'The menu is too long to read at once. Send it in parts, a few pages at a time.',
        false,
      );
    }
    const call = body.content?.find(
      (block) => block.type === 'tool_use' && block.name === RECORD_MENU_TOOL,
    );
    let draft: MenuDraft | undefined;
    try {
      draft = draftFromReading(call?.input);
    } catch {
      draft = undefined;
    }
    if (draft === undefined) {
      throw new ExtractionError(
        'AI_NO_MENU_FOUND',
        'No menu could be read from these files. Try clearer, straighter photos in good light.',
        false,
      );
    }
    const tokens = (value: unknown) => (typeof value === 'number' ? value : null);
    return {
      draft,
      model: typeof body.model === 'string' ? body.model : this.options.model,
      inputTokens: tokens(body.usage?.input_tokens),
      outputTokens: tokens(body.usage?.output_tokens),
    };
  }
}
