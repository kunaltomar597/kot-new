import { ApiError } from '@rp/contracts';

/**
 * The server answered with an error (4xx/5xx). `code` is stable and `message` is plain language
 * that says what to do next (NFR-U04); show the message, branch on the code.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly correlationId: string | undefined;

  constructor(
    status: number,
    body: ApiError,
    correlationId: string | undefined = body.correlationId,
  ) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.correlationId = correlationId;
  }
}

/** The server could not be reached, or did not answer in time: show "offline" and retry. */
export class ApiUnavailableError extends Error {
  readonly reason: 'network' | 'timeout';

  constructor(reason: 'network' | 'timeout', cause?: unknown) {
    super(
      reason === 'timeout'
        ? 'The restaurant server did not answer in time.'
        : 'The restaurant server cannot be reached.',
      { cause },
    );
    this.name = 'ApiUnavailableError';
    this.reason = reason;
  }
}

/**
 * The request or the answer does not match the contract (a bug, or client and server versions
 * too far apart, UPD-006). Not something the person can fix; log it with the correlation id.
 */
export class ApiContractError extends Error {
  readonly correlationId: string | undefined;

  constructor(message: string, correlationId?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ApiContractError';
    this.correlationId = correlationId;
  }
}

/** Maps an error response body to `ApiRequestError`, whatever the server (or a proxy) sent. */
export function errorFromResponse(
  status: number,
  body: unknown,
  correlationId: string | undefined,
): ApiRequestError {
  const parsed = ApiError.safeParse(body);
  if (parsed.success) return new ApiRequestError(status, parsed.data, correlationId);
  return new ApiRequestError(
    status,
    {
      code: `HTTP_${String(status)}`,
      message:
        status >= 500
          ? 'The restaurant server had a problem. Try again.'
          : 'The request was not accepted.',
    },
    correlationId,
  );
}
