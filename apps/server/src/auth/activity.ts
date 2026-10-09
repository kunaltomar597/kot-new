import { IDLE_HEADER } from '@rp/contracts';
import type { Request } from 'express';

/**
 * How long the person had been idle when the app made this call (`x-rp-idle-seconds`, AUTH-005,
 * MOBILE-E3), in milliseconds; 0 when the app does not say, so its calls count as activity as
 * before. The app can only make its own session end sooner with it, never later.
 */
export function idleMsOf(request: Request): number {
  const header = request.headers[IDLE_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d{1,9}$/.test(value)) return 0;
  return Number(value) * 1000;
}
