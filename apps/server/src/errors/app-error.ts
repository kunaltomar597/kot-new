/**
 * An error raised by a server module with an explicit HTTP status and a stable code, for cases
 * the domain package does not cover (not found, conflicts, authentication). The message must be
 * plain language and say what to do next (NFR-U04).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static notFound(what: string, details?: Record<string, unknown>): AppError {
    return new AppError(404, 'NOT_FOUND', `${what} was not found`, details);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(409, code, message, details);
  }
}
