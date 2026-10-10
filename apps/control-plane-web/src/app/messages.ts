import type { Translator } from '@rp/i18n';
import type { z } from 'zod';
import { CpApiError, CpUnavailableError } from './cp-api.js';

/**
 * What to tell the person when an action failed (NFR-U04): the Control Plane's plain-language
 * message when it refused, otherwise what to check.
 */
export function messageOf(error: unknown, t: Translator): string {
  if (error instanceof CpApiError) {
    if (error.status === 403 && !error.code.startsWith('STEP_UP'))
      return t('vendorApp.errors.forbidden');
    return error.message;
  }
  if (error instanceof CpUnavailableError) {
    return t(error.reason === 'timeout' ? 'vendorApp.errors.timeout' : 'vendorApp.errors.network');
  }
  return t('errors.generic');
}

/** True when the Control Plane answered "no such thing". */
export function isNotFound(error: unknown): boolean {
  return error instanceof CpApiError && error.status === 404;
}

/** A form's problems by field, from a failed parse of its request schema. */
export function fieldErrors(error: z.ZodError): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.');
    errors[key] ??= issue.message;
  }
  return errors;
}
