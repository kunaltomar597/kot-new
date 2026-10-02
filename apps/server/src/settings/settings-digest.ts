import { createHash } from 'node:crypto';
import { canonicalJson } from '@rp/domain';

/**
 * The digest of the vendor settings this PC holds (UPD-010): the first 16 hex digits of the
 * SHA-256 of their canonical JSON, exactly as the Control Plane computes it
 * (`apps/control-plane/src/remote-settings/settings-digest.ts`).
 */
export function settingsDigest(values: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex').slice(0, 16);
}
