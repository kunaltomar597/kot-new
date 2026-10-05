/**
 * The pager firmware signing keys built into the software (PGR-011, UPD-007, P2-04b): the SHA-256
 * digests of the vendor's ESP-IDF secure boot v2 public keys, as `espsecure digest-sbv2-public-key`
 * prints them and as the pagers' eFuses hold them. The PC passes on only firmware one of these
 * signed. Up to three may be listed (the pagers' key slots), so a key can be revoked: add the new
 * key here and to the pagers, release, then remove the old one a release later (manual task 30).
 *
 * Empty until the vendor creates the key (manual task 30): production then passes no firmware on.
 * Development and tests add theirs with `RP_PAGER_FIRMWARE_KEYS`.
 */
export const PAGER_FIRMWARE_KEY_DIGESTS: readonly string[] = [];
