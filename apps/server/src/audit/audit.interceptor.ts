import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mergeMap, type Observable } from 'rxjs';
import { principalOf } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from './audit.service.js';
import { AUDITED, type AuditedOptions } from './audited.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entityIdFrom(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** Applies `@Audited()`: records the entry once the handler has succeeded, before responding. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditedOptions | undefined>(AUDITED, context.getHandler());
    if (options === undefined) return next.handle();
    const request = context.switchToHttp().getRequest<{ params?: Record<string, string> }>();
    const principal = principalOf(context.switchToHttp().getRequest());

    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const fromParam =
          options.entityIdParam === undefined ? undefined : request.params?.[options.entityIdParam];
        const fromBody =
          typeof result === 'object' && result !== null
            ? (result as { id?: unknown }).id
            : undefined;
        await this.prisma.transaction((tx) =>
          this.audit.record(tx, {
            action: options.action,
            entityType: options.entityType,
            entityId: entityIdFrom(fromParam ?? fromBody),
            actorId: principal?.staffId ?? null,
            deviceId: principal?.deviceId ?? null,
            ...(principal !== undefined && { restaurantId: principal.restaurantId }),
          }),
        );
        return result;
      }),
    );
  }
}
