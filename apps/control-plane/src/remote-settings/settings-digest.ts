import { createHash } from 'node:crypto';
import { canonicalJson } from '@rp/domain';

/**
 * The digest of a set of vendor settings (UPD-010): the first 16 hex digits of the SHA-256 of
 * their canonical JSON. The restaurant PC computes the same, so either side can tell whether
 * the PC holds the values (the local server has a twin of this function).
 */
export function settingsDigest(values: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex').slice(0, 16);
}
