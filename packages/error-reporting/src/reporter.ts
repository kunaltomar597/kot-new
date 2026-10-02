import { randomUUID } from 'node:crypto';
import { parseDsn, type SentryDsn } from './dsn.js';
import { buildEvent, envelopeOf } from './event.js';

export interface SentryReporterOptions {
  readonly dsn: string;
  /** e.g. `server`, `control-plane`, `console`. */
  readonly component: string;
  readonly release: string;
  readonly environment: string;
  /** Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Reports sent per rolling hour at most (default 60): a loop of errors cannot flood. */
  readonly maxPerHour?: number;
  /** The same error is sent once in this many milliseconds (default a minute). */
  readonly dedupeMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * Sends error reports to a Sentry-compatible service (NFR-O02). Never throws and never blocks
 * the caller: a report that cannot be sent is dropped (the error is in the local log anyway).
 */
export class SentryReporter {
  private readonly dsn: SentryDsn;
  private readonly sentAt: number[] = [];
  private readonly lastSent = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private sentCount = 0;
  private droppedCount = 0;

  constructor(private readonly options: SentryReporterOptions) {
    this.dsn = parseDsn(options.dsn);
  }

  /** Reports sent, and reports dropped by the limits or a failed send. */
  get stats(): { readonly sent: number; readonly dropped: number } {
    return { sent: this.sentCount, dropped: this.droppedCount };
  }

  report(
    error: unknown,
    context: Readonly<Record<string, unknown>> = {},
    tags: Readonly<Record<string, string>> = {},
  ): void {
    const now = this.options.now?.() ?? new Date();
    const event = buildEvent(
      error,
      context,
      {
        component: tags.component ?? this.options.component,
        release: this.options.release,
        environment: this.options.environment,
        tags,
      },
      randomUUID().replaceAll('-', ''),
      now,
    );
    const first = event.exception.values[0];
    const key = `${event.logger}:${first?.type ?? ''}:${first?.value ?? ''}`;
    const time = now.getTime();
    while (this.sentAt.length > 0 && time - (this.sentAt[0] ?? 0) > 3_600_000) this.sentAt.shift();
    const last = this.lastSent.get(key);
    if (
      this.sentAt.length >= (this.options.maxPerHour ?? 60) ||
      (last !== undefined && time - last < (this.options.dedupeMs ?? 60_000))
    ) {
      this.droppedCount += 1;
      return;
    }
    this.sentAt.push(time);
    this.lastSent.set(key, time);
    const sending = this.send(envelopeOf(event, now)).finally(() => {
      this.pending.delete(sending);
    });
    this.pending.add(sending);
  }

  /** Waits for the reports being sent. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async send(envelope: string): Promise<void> {
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(this.dsn.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=rp-error-reporting/1.0`,
        },
        body: envelope,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
      if (response.ok) this.sentCount += 1;
      else this.droppedCount += 1;
    } catch {
      this.droppedCount += 1;
    }
  }
}
