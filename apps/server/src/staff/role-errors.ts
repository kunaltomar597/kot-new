import type { CustomRoleIssue } from '@rp/domain';
import { AppError } from '../errors/app-error.js';

/** Errors of custom roles (P4-02e, AUTH-012), in plain language that says what to do (NFR-U04). */
export const roleErrors = {
  notFound: () => new AppError(404, 'ROLE_NOT_FOUND', 'There is no such custom role.'),
  /** Giving someone a role that is archived. */
  unavailable: () =>
    new AppError(
      404,
      'ROLE_NOT_FOUND',
      'There is no such custom role, or it has been archived. Pick another role.',
    ),
  mismatch: () =>
    new AppError(
      422,
      'ROLE_MISMATCH',
      'This custom role is built on another role. Pick the role it is built on.',
    ),
  permissionsInvalid: (issues: readonly CustomRoleIssue[]) =>
    new AppError(
      422,
      'ROLE_PERMISSIONS_INVALID',
      'Some of these permissions cannot be given this way: a role may add what a manager may do, ' +
        'never what only the Owner may do, and take away only what its base role may do.',
      { issues },
    ),
  nameTaken: (name: string) =>
    new AppError(
      409,
      'ROLE_NAME_TAKEN',
      `Another role is already called "${name}". Pick another name.`,
    ),
  archived: () =>
    new AppError(409, 'ROLE_ARCHIVED', 'This custom role is archived. Restore it first.'),
  alreadyArchived: () =>
    new AppError(409, 'ROLE_ALREADY_ARCHIVED', 'This custom role is already archived.'),
  notArchived: () =>
    new AppError(409, 'ROLE_NOT_ARCHIVED', 'This custom role is not archived.'),
  inUse: (staffCount: number) =>
    new AppError(
      409,
      'ROLE_IN_USE',
      `${String(staffCount)} active ${staffCount === 1 ? 'person has' : 'people have'} this role. ` +
        'Give them another role first.',
      { staffCount },
    ),
};
