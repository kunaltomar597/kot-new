/**
 * An error with an HTTP status and a stable code (`ApiError.code`, e.g. `SIGNATURE_INVALID`). The
 * message is plain language and says what to do next.
 */
export class CpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'CpError';
  }
}
