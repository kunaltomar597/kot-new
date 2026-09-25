/**
 * Random identifiers that work everywhere the client runs. `crypto.randomUUID` exists only in
 * secure contexts (a browser on plain http:// on the LAN has no `randomUUID`), but
 * `crypto.getRandomValues` exists in every browser, Electron, Node and React Native (with the
 * standard polyfill), so UUIDs are built from it.
 */
export function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A new idempotency key (ORD-013). Create it when the person commits an action (taps Send), keep
 * it with that draft, and send the same key on every retry until the server answers: the server
 * then never creates the order, KOT or stock movement twice.
 */
export function newIdempotencyKey(): string {
  return uuidV4();
}

/** Ties the device's logs to the server's for one request (NFR-O01). */
export function newCorrelationId(): string {
  return uuidV4();
}
