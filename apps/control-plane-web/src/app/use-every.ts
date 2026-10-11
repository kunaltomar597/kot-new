import { useEffect } from 'react';

/** Calls `refresh` every `ms` while the page is open (fleet views stay current without a reload). */
export function useEvery(refresh: () => void, ms: number): void {
  useEffect(() => {
    const timer = setInterval(refresh, ms);
    return () => {
      clearInterval(timer);
    };
  }, [refresh, ms]);
}
