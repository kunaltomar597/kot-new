/**
 * Latency figures for the load run (P8-01a). Percentiles use the nearest-rank method: the p95 of
 * 100 samples is the 95th smallest, a value that was really measured.
 */

export interface LatencySummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** The nearest-rank percentile of values sorted ascending; null when there are none. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0] ?? null;
  const rank = Math.min(sorted.length, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** Latencies of one kind, in milliseconds. */
export class Samples {
  private readonly values: number[] = [];

  add(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error(`Not a latency: ${String(ms)}`);
    this.values.push(Math.max(0, ms));
  }

  get count(): number {
    return this.values.length;
  }

  summary(): LatencySummary {
    const sorted = [...this.values].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? null,
    };
  }
}

/** Samples by name, created on first use (one per REST operation, say). */
export class SampleSets {
  private readonly sets = new Map<string, Samples>();

  of(name: string): Samples {
    let samples = this.sets.get(name);
    if (samples === undefined) {
      samples = new Samples();
      this.sets.set(name, samples);
    }
    return samples;
  }

  clear(): void {
    this.sets.clear();
  }

  summaries(): Record<string, LatencySummary> {
    return Object.fromEntries(
      [...this.sets].sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => [name, s.summary()]),
    );
  }
}
