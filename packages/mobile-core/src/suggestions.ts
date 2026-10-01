import type { RecommendationEventInput } from '@rp/contracts';

export interface SuggestionTrackerOptions {
  /** Sends one batch of what diners or waiters did with suggestions. */
  readonly send: (events: RecommendationEventInput[]) => Promise<void>;
  /** How long events wait to be sent together (default 3 s). */
  readonly flushMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The server takes at most this many events a request. */
const BATCH = 50;
/** Kept at most while the server cannot be reached; the oldest go first beyond it. */
const KEEP = 500;

/**
 * What happens to suggestions (REC-008): shown, opened and put in the cart, sent in batches so a
 * scrolled row costs one request, and kept to send again when the server was out of reach.
 * ORDERED is counted by the server from the order itself.
 */
export class SuggestionTracker {
  private queue: RecommendationEventInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;

  constructor(private readonly options: SuggestionTrackerOptions) {}

  record(event: RecommendationEventInput): void {
    this.queue.push(event);
    if (this.queue.length > KEEP) this.queue.splice(0, this.queue.length - KEEP);
    if (this.queue.length >= BATCH) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushMs ?? 3_000);
  }

  /** Sends what is waiting now; one sending at a time. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sending ??= this.sendAll().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  /** Stops the timer; what is still waiting is sent once more. */
  stop(): Promise<void> {
    return this.flush();
  }

  private async sendAll(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, BATCH);
      try {
        await this.options.send(batch);
      } catch (error) {
        this.options.onError?.(error);
        return;
      }
      this.queue = this.queue.slice(batch.length);
    }
  }
}
