import { SetMetadata } from '@nestjs/common';
import type { Capability } from '@rp/domain';

export const PUBLIC_ROUTE = 'rp:public';
export const REQUIRED_CAPABILITY = 'rp:capability';

/**
 * Marks a route (or controller) that needs no signed-in staff member. Use rarely and say why in a
 * comment next to it (CONVENTIONS "Security habits").
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);

/**
 * The capability from the BRD §4.2 matrix (`@rp/domain` permissions) a route needs. Every route
 * must declare one or be `@Public()`; anything else is denied (AUTH-010, SEC-003).
 */
export const RequireCapability = (capability: Capability): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_CAPABILITY, capability);
