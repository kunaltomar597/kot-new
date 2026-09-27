import { ApiRequestError, ApiUnavailableError } from '@rp/api-client';
import type { Translator } from '@rp/i18n';
import { InvalidServerAddressError } from '@rp/mobile-core';

/**
 * What to tell the person when an action failed (NFR-U04): the server's plain-language message
 * when it refused, otherwise what to check.
 */
export function messageOf(error: unknown, t: Translator): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof ApiUnavailableError) {
    return t(error.reason === 'timeout' ? 'errors.timeout' : 'errors.network');
  }
  if (error instanceof InvalidServerAddressError) return t('mobile.invalidServer');
  return t('errors.generic');
}

/** Pairing codes are typed however people type them: `abcd efgh` becomes `ABCD-EFGH`. */
export function formatPairingCode(input: string): string {
  const characters = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters;
}
