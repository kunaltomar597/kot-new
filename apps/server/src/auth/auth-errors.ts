import { AppError } from '../errors/app-error.js';

/**
 * Errors of authentication and authorisation, in plain language that says what to do next
 * (NFR-U04). Credential failures never say which part was wrong.
 */
export const authErrors = {
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'),
  tokenExpired: () =>
    new AppError(401, 'TOKEN_EXPIRED', 'Your sign-in needs renewing. The app will do this now.'),
  tokenInvalid: () => new AppError(401, 'TOKEN_INVALID', 'Please sign in again.'),
  sessionExpired: () =>
    new AppError(
      401,
      'SESSION_EXPIRED',
      'You were signed out after a period of inactivity. Sign in again.',
    ),
  sessionRevoked: () =>
    new AppError(401, 'SESSION_REVOKED', 'You have been signed out. Sign in again.'),
  deviceNotRecognised: () =>
    new AppError(
      401,
      'DEVICE_NOT_RECOGNISED',
      'This device is not paired with the restaurant. Ask a manager to pair it.',
    ),
  deviceMismatch: () =>
    new AppError(
      401,
      'DEVICE_MISMATCH',
      'This sign-in belongs to another device. Sign in again here.',
    ),
  invalidCredentials: (attemptsRemaining?: number) =>
    new AppError(
      401,
      'INVALID_CREDENTIALS',
      attemptsRemaining === undefined
        ? 'That did not match. Check and try again.'
        : `That did not match. ${String(attemptsRemaining)} ${attemptsRemaining === 1 ? 'try' : 'tries'} left before the login is locked.`,
      attemptsRemaining === undefined ? undefined : { attemptsRemaining },
    ),
  locked: (lockedUntil: Date) =>
    new AppError(
      423,
      'ACCOUNT_LOCKED',
      'This login is locked after too many wrong attempts. Wait, or ask a manager to unlock it.',
      { lockedUntil: lockedUntil.toISOString() },
    ),
  rateLimited: () =>
    new AppError(
      429,
      'RATE_LIMITED',
      'Too many attempts from this device. Wait a minute and try again.',
    ),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'),
  ownerOnly: () => new AppError(403, 'OWNER_ONLY', 'Only the Owner can do this.'),
  secondFactorRequired: () =>
    new AppError(
      403,
      'SECOND_FACTOR_REQUIRED',
      'Confirm your Owner password and authenticator code to continue.',
    ),
  overrideRequired: (capability: string) =>
    new AppError(
      403,
      'OVERRIDE_REQUIRED',
      'A manager must approve this. Ask a manager to enter their PIN.',
      { capability },
    ),
  overrideInvalid: () =>
    new AppError(
      403,
      'OVERRIDE_INVALID',
      'The manager approval has expired or was already used. Ask the manager to approve again.',
    ),
  overrideNotNeeded: () =>
    new AppError(
      409,
      'OVERRIDE_NOT_NEEDED',
      'You can do this yourself; no manager approval is needed.',
    ),
  approverNotAllowed: () =>
    new AppError(403, 'APPROVER_NOT_ALLOWED', 'Only a manager or the Owner can approve this.'),
  kitchenStationMode: () =>
    new AppError(
      403,
      'KITCHEN_STATION_MODE',
      'Kitchen screens work in station mode, so kitchen staff do not sign in individually.',
    ),
  totpNotStarted: () =>
    new AppError(
      409,
      'TOTP_ENROLMENT_NOT_STARTED',
      'Start authenticator setup first, then enter a code.',
    ),
  invalidCode: () =>
    new AppError(
      422,
      'INVALID_CODE',
      'That code did not match. Enter the current code from the app.',
    ),
  currentPasswordRequired: () =>
    new AppError(422, 'CURRENT_PASSWORD_REQUIRED', 'Enter the current password to change it.'),
};
