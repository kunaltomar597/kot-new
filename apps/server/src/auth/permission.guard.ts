import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Capability, grantFor } from '@rp/domain';
import { AppError } from '../errors/app-error.js';
import { PUBLIC_ROUTE, REQUIRED_CAPABILITY } from './decorators.js';
import type { RequestWithPrincipal } from './principal.js';

/**
 * Global guard: deny by default (AUTH-010, SEC-003).
 *
 * - `@Public()` routes pass.
 * - `@RequireCapability(c)` routes need a principal (401 otherwise) whose role is granted `c` in
 *   the permission matrix. ALLOW passes; OWN passes with `request.ownershipRequired` set so the
 *   service checks the table or shift belongs to the person; OVERRIDE needs a manager override
 *   token (P0-10) and is refused until one is presented; DENY is refused.
 * - Routes that declare neither are refused and logged: a missing declaration is a bug.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const capability = this.reflector.getAllAndOverride<Capability | undefined>(
      REQUIRED_CAPABILITY,
      targets,
    );
    if (capability === undefined) {
      this.logger.error(
        { path: request.originalUrl },
        'Route declares neither @Public() nor @RequireCapability(); refusing the request',
      );
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.');
    }

    const principal = request.principal;
    if (principal === undefined) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
    }

    const grant = grantFor(principal.role, capability);
    switch (grant) {
      case 'ALLOW':
        return true;
      case 'OWN':
        request.ownershipRequired = true;
        return true;
      case 'OVERRIDE':
        throw new AppError(
          403,
          'OVERRIDE_REQUIRED',
          'A manager must approve this. Ask a manager to enter their PIN.',
          { capability },
        );
      case 'DENY':
        throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.', {
          capability,
        });
    }
  }
}
