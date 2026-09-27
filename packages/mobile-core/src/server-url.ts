/** Thrown for a server address that is not `host[:port]` or an http(s) URL. */
export class InvalidServerAddressError extends Error {
  constructor() {
    super('Enter the server address shown on the POS, for example 192.168.1.20:8443.');
    this.name = 'InvalidServerAddressError';
  }
}

/**
 * The local server's base URL from what a person typed: `192.168.1.20:8443` becomes
 * `https://192.168.1.20:8443` (the LAN is served over TLS, ADR-0011); an explicit `http://` is kept
 * for development servers.
 */
export function normalizeServerUrl(input: string): string {
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidServerAddressError();
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
    throw new InvalidServerAddressError();
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw new InvalidServerAddressError();
  }
  return url.origin;
}
