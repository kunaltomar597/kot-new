import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReportRange } from './report-view.js';

export type ReportData<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | {
      readonly status: 'ready';
      readonly value: T;
      /** A new range is loading: the figures shown are the previous range's. */
      readonly refreshing: boolean;
    };

/**
 * A report for the chosen range, read again when the range changes. While the new range loads
 * the previous figures stay on screen, marked as refreshing (RPT-016: no flash, no jump).
 */
export function useReport<T>(
  load: (range: ReportRange) => Promise<T>,
  range: ReportRange,
  /** Anything else the report depends on (filters): a change reads it again too. */
  also = '',
): { data: ReportData<T>; reload: () => void } {
  const [data, setData] = useState<ReportData<T>>({ status: 'loading' });
  const generation = useRef(0);
  const latest = useRef(load);
  latest.current = load;

  const reload = useCallback(() => {
    const current = ++generation.current;
    setData((previous) =>
      previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' },
    );
    latest.current({ from: range.from, to: range.to }).then(
      (value) => {
        if (current === generation.current) setData({ status: 'ready', value, refreshing: false });
      },
      (error: unknown) => {
        if (current === generation.current) setData({ status: 'error', error });
      },
    );
    // `also` is only a trigger: what it stands for is in `load`.
  }, [range.from, range.to, also]);

  useEffect(() => {
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { data, reload };
}
