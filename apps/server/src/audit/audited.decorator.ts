import { SetMetadata } from '@nestjs/common';

export const AUDITED = 'rp:audited';

export interface AuditedOptions {
  /** UPPER_SNAKE action, e.g. "SETTINGS_CHANGED". */
  readonly action: string;
  /** lower_snake entity type, e.g. "setting". */
  readonly entityType: string;
  /** Route parameter holding the entity id; otherwise the `id` of the response body is used. */
  readonly entityIdParam?: string;
}

/**
 * Writes an audit entry after the handler succeeds, in its own transaction (AUD-001). For simple
 * administrative actions only: money actions (discounts, voids, payments, bills, cash, day-end)
 * call `AuditService.record` inside their own business transaction, so the change and its audit
 * entry commit together.
 */
export const Audited = (options: AuditedOptions): MethodDecorator => SetMetadata(AUDITED, options);
