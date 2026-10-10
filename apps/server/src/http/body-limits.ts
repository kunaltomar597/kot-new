import { DEVICE_TOKEN_HEADER } from '@rp/contracts';
import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authErrors } from '../auth/auth-errors.js';
import { type DeviceAuthenticator, rememberDevice } from '../auth/device.js';
import { AppError } from '../errors/app-error.js';
import { mapError } from '../errors/error-mapping.js';

/**
 * What a caller without a paired device may send, in bytes (PC-D1): pairing, a device token and
 * the first run all fit in a few hundred.
 */
export const ANONYMOUS_BODY_LIMIT = 16 * 1024;
/** Any other request from a paired device. */
export const JSON_BODY_LIMIT = '1mb';
/**
 * A 5 MB photo (P1-04) or menu workbook (P1-05) as base64 is about 6.7 MB of JSON; only those
 * upload paths get this larger limit.
 */
export const UPLOAD_BODY_LIMIT = '7mb';
/** Up to 40 MB of menu photos or PDFs for AI import (P6-04b), in base64. */
export const AI_IMPORT_BODY_LIMIT = '55mb';

/** A path and everything under it. */
const under = (prefix: string) => (path: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

type RequestWithId = Request & { id?: unknown };

/**
 * The JSON body parsers, chosen by who is calling. The device token is checked before any body is
 * read (PC-D1), so a host on the LAN without a paired device cannot make the server buffer and
 * parse megabytes before refusing it: it gets `ANONYMOUS_BODY_LIMIT`, and a larger body announced
 * without a device token is refused before a byte of it is read. The check's result is kept for
 * the authentication middleware, so it runs once per request. A device whose token no longer
 * verifies hears `DEVICE_NOT_RECOGNISED` for a large body, not 413, so its client renews the
 * token and sends the body again.
 */
export function bodyParsers(
  devices: DeviceAuthenticator,
  paths: { readonly uploads: readonly string[]; readonly aiImport: string },
): RequestHandler {
  const anonymous = json({ limit: ANONYMOUS_BODY_LIMIT });
  const standard = json({ limit: JSON_BODY_LIMIT });
  const upload = json({ limit: UPLOAD_BODY_LIMIT });
  const aiImport = json({ limit: AI_IMPORT_BODY_LIMIT });
  const isUpload = paths.uploads.map(under);
  const isAiImport = under(paths.aiImport);

  const refuse = (request: Request, response: Response) => {
    const error =
      request.headers[DEVICE_TOKEN_HEADER] === undefined
        ? new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.')
        : authErrors.deviceNotRecognised();
    const id = (request as RequestWithId).id;
    const mapped = mapError(error, typeof id === 'string' ? id : undefined);
    response.status(mapped.status).json(mapped.body);
  };

  const parse = (request: Request, response: Response, next: NextFunction, paired: boolean) => {
    if (!paired) {
      const announced = Number(request.headers['content-length'] ?? 0);
      if (announced > ANONYMOUS_BODY_LIMIT && request.headers[DEVICE_TOKEN_HEADER] === undefined) {
        // Answered before a byte is read; Node discards the rest as it arrives.
        refuse(request, response);
        return;
      }
      // Read up to the limit; a larger body is discarded unread before the answer, as clients
      // that send a device token (the apps) expect.
      anonymous(request, response, (error?: unknown) => {
        if (isTooLarge(error)) refuse(request, response);
        else next(error);
      });
      return;
    }
    const path = request.path;
    const parser = isAiImport(path)
      ? aiImport
      : isUpload.some((matches) => matches(path))
        ? upload
        : standard;
    parser(request, response, next);
  };

  return (request: Request, response: Response, next: NextFunction) => {
    devices.authenticate(request).then(
      (device) => {
        rememberDevice(request, device);
        parse(request, response, next, device !== undefined);
      },
      // Not remembered: the authentication middleware checks again and reports the failure.
      () => {
        parse(request, response, next, false);
      },
    );
  };
}

function isTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}
