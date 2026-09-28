import type { StaffRefusal } from '@rp/domain';
import { authErrors } from '../auth/auth-errors.js';
import { AppError } from '../errors/app-error.js';

/** Errors of staff administration (P4-02a), in plain language that says what to do (NFR-U04). */
export const staffErrors = {
  notFound: () => new AppError(404, 'STAFF_NOT_FOUND', 'There is no such person.'),
  pinLength: (length: number) =>
    new AppError(422, 'PIN_LENGTH', `The PIN must have exactly ${String(length)} digits.`, {
      pinLength: length,
    }),
  /** Why `decideStaffChange` refused (`@rp/domain`). */
  refused: (reason: StaffRefusal): AppError => {
    switch (reason) {
      case 'DENIED':
        return authErrors.forbidden();
      case 'OWNER_ONLY':
        return authErrors.ownerOnly();
      case 'SECOND_FACTOR_REQUIRED':
        return authErrors.secondFactorRequired();
      case 'OWNER_RECORD':
        return new AppError(
          422,
          'OWNER_RECORD',
          'The Owner always stays active and keeps the Owner role.',
        );
      case 'OWN_RECORD':
        return new AppError(
          422,
          'OWN_RECORD',
          'You cannot deactivate yourself or change your own role. Ask the Owner.',
        );
      case 'ALREADY_ACTIVE':
        return new AppError(409, 'STAFF_ALREADY_ACTIVE', 'This person is already active.');
      case 'ALREADY_INACTIVE':
        return new AppError(409, 'STAFF_ALREADY_INACTIVE', 'This person is already deactivated.');
    }
  },
};
