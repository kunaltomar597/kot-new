import { v7 as uuidv7 } from 'uuid';

/** A new time-ordered UUIDv7 for any entity (ADR-0005). */
export function newId(): string {
  return uuidv7();
}
