import type { AuthenticatedDevice } from '../auth/device.js';
import { AppError } from '../errors/app-error.js';

/**
 * Object-level check (AUTH-009, SEC-003): a table tablet may only read or act on its own table.
 * Other device types are not limited here (staff permissions apply to them).
 */
export function assertTableAccess(device: AuthenticatedDevice | undefined, tableId: string): void {
  if (device?.type === 'TABLE_TABLET' && device.tableId !== tableId) {
    throw new AppError(403, 'NOT_THIS_TABLE', 'This tablet can only be used for its own table.');
  }
}
