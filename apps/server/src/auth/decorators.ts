import { SetMetadata } from '@nestjs/common';
import type { Capability } from '@rp/domain';

/** How a route is protected; mirrors `RouteDefinition.capability` in `@rp/contracts`. */
export const ROUTE_ACCESS = 'rp:access';

export type RouteAccess =
  | { readonly kind: 'PUBLIC' }
  | { readonly kind: 'DEVICE' }
  | {
      readonly kind: 'SESSION';
      /** A kitchen screen in station mode may call it with nobody signed in (AUTH-005). */
      readonly stationMode?: boolean;
    }
  | {
      readonly kind: 'CAPABILITY';
      readonly capability: Capability;
      /** A kitchen screen in station mode may call it with nobody signed in (AUTH-005). */
      readonly stationMode?: boolean;
    };

type RouteDecorator = MethodDecorator & ClassDecorator;

/**
 * Marks a route (or controller) that needs neither a paired device nor a signed-in person. Use
 * rarely and say why in a comment next to it (CONVENTIONS "Security habits").
 */
export const Public = (): RouteDecorator =>
  SetMetadata(ROUTE_ACCESS, { kind: 'PUBLIC' } satisfies RouteAccess);

/** Needs a paired device but nobody signed in (login screen, token refresh). */
export const RequireDevice = (): RouteDecorator =>
  SetMetadata(ROUTE_ACCESS, { kind: 'DEVICE' } satisfies RouteAccess);

/** Any signed-in person may call it; the service checks anything further (e.g. Owner only). */
export const RequireSession = (options: { stationMode?: boolean } = {}): RouteDecorator =>
  SetMetadata(ROUTE_ACCESS, {
    kind: 'SESSION',
    ...(options.stationMode === true && { stationMode: true }),
  } satisfies RouteAccess);

/**
 * The capability from the BRD §4.2 matrix (`@rp/domain` permissions) a route needs. Every route
 * must declare its access with one of these decorators; anything else is denied (AUTH-010,
 * SEC-003).
 */
export const RequireCapability = (
  capability: Capability,
  options: { stationMode?: boolean } = {},
): RouteDecorator =>
  SetMetadata(ROUTE_ACCESS, {
    kind: 'CAPABILITY',
    capability,
    ...(options.stationMode === true && { stationMode: true }),
  } satisfies RouteAccess);
