/**
 * The vendor's licence-signing public keys built into the software (LIC-003): SPKI DER, base64.
 * An installation accepts a licence only when one of these signed it. To rotate, add the new key
 * here, release, then remove the old one a release later (manual task 23).
 *
 * Empty until the vendor creates the key in the cloud KMS: production then accepts no licence and
 * restricts from the next business day, so the key must be added before the pilot.
 */
export const VENDOR_LICENCE_KEYS: readonly string[] = [];
