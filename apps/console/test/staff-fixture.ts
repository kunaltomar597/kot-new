import type { OwnerSecurityResponse, StaffView } from '@rp/contracts';
import type { Role } from '@rp/domain';
import { inMinutes, RESTAURANT_ID, STAFF } from './fakes.js';

/** Staff records for the Staff page tests: the people of `fakes.ts`, and more. */

const CREATED = '2026-09-20T10:00:00.000Z';

export function staffView(role: Role, overrides: Partial<StaffView> = {}): StaffView {
  const tile = STAFF[role];
  return {
    id: tile.staffId,
    displayName: tile.displayName,
    role,
    active: true,
    phone: null,
    email: null,
    photoId: null,
    hasPin: true,
    lockedUntil: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

/** Ravi's login is locked after wrong PINs. */
export const lockedRavi = (): StaffView =>
  staffView('WAITER', { phone: '+91 98765 43210', lockedUntil: inMinutes(12) });

/** Priya left and was deactivated. */
export const PRIYA = staffView('WAITER', {
  id: '0199a0e0-0000-7000-8000-000000000106',
  displayName: 'Priya',
  active: false,
});

/** Everyone, as the server lists them: active first, by name. */
export function team(): StaffView[] {
  return [
    staffView('CASHIER'),
    staffView('KITCHEN'),
    staffView('OWNER'),
    staffView('MANAGER'),
    lockedRavi(),
    PRIYA,
  ];
}

export function staffList(staff: StaffView[] = team(), pinLength: 4 | 6 = 4) {
  return { staff, pinLength };
}

export function ownerSecurity(
  overrides: Partial<OwnerSecurityResponse> = {},
): OwnerSecurityResponse {
  return {
    hasPassword: true,
    hasAuthenticator: true,
    recoveryCodesLeft: 10,
    secondFactorValidUntil: null,
    ...overrides,
  };
}

export const SECOND_FACTOR_REQUIRED = {
  status: 403,
  body: {
    code: 'SECOND_FACTOR_REQUIRED',
    message: 'Confirm your Owner password and authenticator code to continue.',
  },
};

/** `RestaurantChanged` as the live connection delivers it. */
export function staffChanged(sequence: number) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000009${String(sequence).padStart(2, '0')}`,
      type: 'RestaurantChanged',
      version: 1,
      occurredAt: '2026-09-28T10:00:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-28',
      payload: { part: 'STAFF' },
    },
  };
}
