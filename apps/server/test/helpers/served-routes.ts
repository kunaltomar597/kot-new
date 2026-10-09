import { type INestApplication, RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { ROUTE_ACCESS, type RouteAccess } from '../../src/auth/decorators.js';

/** One route the application serves, with the access its controller declares. */
export interface ServedRoute {
  readonly method: string;
  /** Full path with Express-style parameters, as in the route registry. */
  readonly path: string;
  /** Undefined when the controller declares nothing (the guard then refuses it). */
  readonly access: RouteAccess | undefined;
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

const join = (...parts: string[]) =>
  `/${parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '')
    .join('/')}`;

/**
 * Every route of the application's controllers, read from Nest's own metadata, with the access
 * the permission guard will apply (the handler's, else the controller's). Test controllers in
 * `except` are left out.
 */
export function servedRoutes(
  app: INestApplication,
  except: readonly unknown[] = [],
): readonly ServedRoute[] {
  const skipped = new Set(except);
  const served: ServedRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (controller === null || skipped.has(controller)) continue;
      const base = (Reflect.getMetadata('path', controller) as string | undefined) ?? '';
      const classAccess = Reflect.getMetadata(ROUTE_ACCESS, controller) as RouteAccess | undefined;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const path = Reflect.getMetadata('path', handler) as string | undefined;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        if (path === undefined || method === undefined) continue;
        served.push({
          method: METHOD_NAMES[method] ?? String(method),
          path: join('api/v1', base, path),
          access:
            (Reflect.getMetadata(ROUTE_ACCESS, handler) as RouteAccess | undefined) ?? classAccess,
        });
      }
    }
  }
  return served;
}

/** The access in the registry's words: a capability, `SESSION`, `PUBLIC` or `DEVICE(<types>)`. */
export function accessName(access: RouteAccess | undefined): string {
  if (access === undefined) return 'UNDECLARED';
  switch (access.kind) {
    case 'CAPABILITY':
      return access.capability;
    case 'DEVICE':
      return `DEVICE(${[...access.devices].sort().join(',')})`;
    default:
      return access.kind;
  }
}
