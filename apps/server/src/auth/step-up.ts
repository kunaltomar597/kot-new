import type { Principal } from './principal.js';

/**
 * The Owner confirmed password + second factor within the last `stepUpMinutes` (AUTH-006). Pure,
 * so every Owner-only check (routes, settings) uses the same rule.
 */
export function hasFreshStepUp(
  principal: Pick<Principal, 'role' | 'secondFactorAt'>,
  stepUpMinutes: number,
  now: Date = new Date(),
): boolean {
  return (
    principal.role === 'OWNER' &&
    principal.secondFactorAt !== null &&
    now.getTime() - principal.secondFactorAt.getTime() <= stepUpMinutes * 60_000
  );
}
