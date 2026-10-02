import { scrubText, scrubValue } from '@rp/domain';

export interface SentryFrame {
  readonly filename: string;
  readonly function: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app: boolean;
}

export interface SentryEvent {
  readonly event_id: string;
  readonly timestamp: number;
  readonly platform: 'node' | 'javascript';
  readonly level: 'error';
  readonly logger: string;
  readonly release: string;
  readonly environment: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly exception: {
    readonly values: readonly {
      readonly type: string;
      readonly value: string;
      readonly stacktrace?: { readonly frames: readonly SentryFrame[] };
    }[];
  };
  readonly extra: Readonly<Record<string, unknown>>;
}

/** A user's folder in a path ("C:\Users\Asha", "/home/asha"): replaced by "~". */
const HOME = /(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s:)]+/g;

/** The frames of a V8 stack trace, oldest first as Sentry wants them, without user names. */
export function stackFrames(stack: string | undefined): SentryFrame[] {
  if (stack === undefined) return [];
  const frames: SentryFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (match === null) continue;
    const [, fn, file = '', lineno, colno] = match;
    const filename = file.replace(HOME, '~');
    frames.push({
      filename,
      function: fn ?? '?',
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

function describe(error: unknown): { type: string; message: string; stack: string | undefined } {
  if (error instanceof Error)
    return { type: error.name, message: error.message, stack: error.stack };
  return {
    type: 'NonError',
    message:
      typeof error === 'string' ? error : error === undefined ? 'undefined' : JSON.stringify(error),
    stack: undefined,
  };
}

/** A Sentry event for an error, scrubbed of secrets and personal data (NFR-O02, SEC-015). */
export function buildEvent(
  error: unknown,
  context: Readonly<Record<string, unknown>>,
  options: {
    readonly component: string;
    readonly release: string;
    readonly environment: string;
    readonly platform?: 'node' | 'javascript';
    readonly tags?: Readonly<Record<string, string>>;
  },
  eventId: string,
  now: Date,
): SentryEvent {
  const { type, message, stack } = describe(error);
  const frames = stackFrames(stack);
  return {
    event_id: eventId,
    timestamp: now.getTime() / 1_000,
    platform: options.platform ?? 'node',
    level: 'error',
    logger: options.component,
    release: options.release,
    environment: options.environment,
    tags: { component: options.component, ...options.tags },
    exception: {
      values: [
        {
          type,
          value: scrubText(message).replace(HOME, '~'),
          ...(frames.length > 0 && { stacktrace: { frames } }),
        },
      ],
    },
    extra: scrubValue(context) as Record<string, unknown>,
  };
}

/** The event as a Sentry envelope: a header, the item header and the event, one per line. */
export function envelopeOf(event: SentryEvent, sentAt: Date): string {
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: sentAt.toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
}
