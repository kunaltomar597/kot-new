/** Waiting for the restaurant's server after the PC starts (NFR-A04): it may take a minute. */

export interface WaitOptions {
  readonly fetch: typeof fetch;
  /** The server's health endpoint, e.g. `https://127.0.0.1:8080/api/v1/health`. */
  readonly healthUrl: string;
  /** Starts at this and doubles to `maxIntervalMs`. */
  readonly intervalMs: number;
  readonly maxIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Stops waiting (the shell is closing). */
  readonly signal?: AbortSignal;
}

/** Resolves once the server answers its health check; never gives up while the shell runs. */
export async function waitForServer(options: WaitOptions): Promise<void> {
  let interval = options.intervalMs;
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('Stopped waiting for the server');
    try {
      const response = await options.fetch(options.healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await options.sleep(interval);
    interval = Math.min(interval * 2, options.maxIntervalMs);
  }
}
