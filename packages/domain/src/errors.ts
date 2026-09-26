/**
 * Machine-readable error codes raised by the domain package.
 * The server maps these to HTTP/API errors; clients map them to plain-language messages (NFR-U04).
 */
export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_RATE'
  | 'INVALID_QUANTITY'
  | 'INVALID_ARGUMENT'
  | 'DISCOUNT_EXCEEDS_AMOUNT'
  | 'UNKNOWN_TAX_GROUP'
  | 'INVALID_TAX_GROUP'
  | 'INVALID_TRANSITION'
  | 'INVALID_SELECTION'
  | 'INVOICE_NUMBER_TOO_LONG'
  | 'INVALID_INVOICE_SERIES'
  | 'INVALID_DATE'
  | 'INVALID_TIME'
  | 'INVALID_PAYMENT'
  | 'OVERPAYMENT';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
