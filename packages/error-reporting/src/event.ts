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
    const frame = frameOf(line);
    if (frame === undefined) continue;
    const filename = frame.file.replace(HOME, '~');
    frames.push({
      filename,
      function: frame.fn ?? '?',
      lineno: frame.lineno,
      colno: frame.colno,
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

const DIGITS = /^\d+$/;

/**
 * One V8 stack line, `at fn (file:line:col)` or `at file:line:col`, read by its last separators
 * rather than a backtracking regular expression, so a long or odd line costs no more than its
 * length (an error's message is not ours to trust).
 */
function frameOf(
  line: string,
): { fn: string | undefined; file: string; lineno: number; colno: number } | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('at ')) return undefined;
  let place = trimmed.slice(3).trimEnd();
  let fn: string | undefined;
  if (place.endsWith(')')) {
    const open = place.lastIndexOf(' (');
    if (open > 0) {
      fn = place.slice(0, open);
      place = place.slice(open + 2, -1);
    } else {
      place = place.slice(0, -1);
    }
  }
  const colon = place.lastIndexOf(':');
  const lineColon = colon > 0 ? place.lastIndexOf(':', colon - 1) : -1;
  if (lineColon <= 0) return undefined;
  const lineno = place.slice(lineColon + 1, colon);
  const colno = place.slice(colon + 1);
  if (!DIGITS.test(lineno) || !DIGITS.test(colno)) return undefined;
  return { fn, file: place.slice(0, lineColon), lineno: Number(lineno), colno: Number(colno) };
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
