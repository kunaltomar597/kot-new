import type { RequestHandler } from 'express';
import type { TlsService } from './tls.service.js';

/** Where people download the CA certificate to install it in a browser (ADR-0011). */
export const CA_DOWNLOAD_PATH = '/ca.crt';

/**
 * Serves the installation's CA certificate as a file browsers offer to install (Android, iOS,
 * Windows): `https://<server>:<port>/ca.crt`. Public, because it is needed before the browser
 * trusts the server; people compare its fingerprint with the one the POS shows before trusting
 * it (docs/runbooks/lan-tls.md). Without TLS the request falls through to a 404.
 */
export function caDownloadMiddleware(tls: TlsService): RequestHandler {
  return (request, response, next) => {
    const ca =
      request.path === CA_DOWNLOAD_PATH && (request.method === 'GET' || request.method === 'HEAD')
        ? tls.ca()
        : undefined;
    if (ca === undefined) {
      next();
      return;
    }
    response.setHeader('content-type', 'application/x-x509-ca-cert');
    response.setHeader('content-disposition', 'attachment; filename="restaurant-ca.crt"');
    response.setHeader('cache-control', 'no-cache');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(ca.certificate);
  };
}
