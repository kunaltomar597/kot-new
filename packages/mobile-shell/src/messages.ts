import { ApiRequestError, ApiUnavailableError } from '@rp/api-client';
import type { Translator } from '@rp/i18n';
import {
  InvalidServerAddressError,
  ServerMismatchError,
  ServerUnreachableError,
  UnverifiedServerError,
} from '@rp/mobile-core';

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
  if (error instanceof ServerUnreachableError) return t('pairing.unreachable');
  if (error instanceof ServerMismatchError) return t('pairing.mismatch');
  if (error instanceof UnverifiedServerError) return t('pairing.unverified');
  return t('errors.generic');
}

/** A certificate fingerprint (`AB:CD:…`, 32 pairs) as four lines of eight pairs, for comparing. */
export function formatFingerprint(sha256: string): string {
  const pairs = sha256.split(':');
  const lines: string[] = [];
  for (let start = 0; start < pairs.length; start += 8) {
    lines.push(pairs.slice(start, start + 8).join(':'));
  }
  return lines.join('\n');
}

/** Pairing codes are typed however people type them: `abcd efgh` becomes `ABCD-EFGH`. */
export function formatPairingCode(input: string): string {
  const characters = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters;
}
