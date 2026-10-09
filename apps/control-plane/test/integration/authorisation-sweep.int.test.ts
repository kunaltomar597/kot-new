import { type INestApplication, RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { ApiError, type RouteDefinition } from '@rp/contracts';
import {
  CONTROL_PLANE_ERRORS,
  CONTROL_PLANE_ROUTES,
  type ControlPlaneAccess,
  VENDOR_CAPABILITIES,
  VENDOR_ROLES,
  type VendorCapability,
  type VendorRole,
  vendorMay,
} from '@rp/contracts/control-plane';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { PUBLIC_ROUTE } from '../../src/auth/public.decorator.js';
import { VENDOR_ROUTE } from '../../src/vendor/vendor.guard.js';
import { ACTOR, enrolledInstallation } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

/**
 * The Control Plane's authorisation sweep (SEC-017, SEC-003, SEC-018): its routes match the
 * registry with the access each declares, and every endpoint refuses the wrong caller before any
 * work is done: no credential, a restaurant PC on a vendor endpoint, vendor staff on a restaurant
 * PC's endpoint, a revoked PC, a signed-out session and each role without the capability. What an
 * allowed caller may do is each feature's own tests.
 */

type Route = RouteDefinition<ControlPlaneAccess>;
const routes: readonly Route[] = CONTROL_PLANE_ROUTES;

/** The endpoints anyone may call, each reviewed (docs/security/authorisation.md). */
const PUBLIC_ROUTES = [
  'GET /v1/health',
  'POST /v1/enrolments',
  'GET /v1/bills/:token',
  'POST /v1/cloud-restores',
  'POST /v1/vendor/session',
  'POST /v1/vendor/setup',
  'POST /v1/vendor/setup/confirm',
  // The development object store's signed URLs (404 in staging and production, which use S3).
  'PUT /v1/object-store/:grant',
  'GET /v1/object-store/:grant',
].sort();

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: INestApplication;
let pc: TestInstallation;
let revoked: TestInstallation;
const sessions = {} as Record<VendorRole, string>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  pc = await enrolledInstallation(app);
  revoked = await enrolledInstallation(app);
  await app.get(AdminService).revokeInstallation(revoked.id ?? '', 'Sweep', ACTOR);
  for (const role of VENDOR_ROLES) {
    sessions[role] = await signInVendor(app, await vendorAccount(app, role));
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const key = (route: Route) => `${route.method} ${route.path}`;
const isPublic = (route: Route) => route.capability === 'PUBLIC';
const isInstallation = (route: Route) => route.capability === 'INSTALLATION';
const isVendor = (route: Route) => !isPublic(route) && !isInstallation(route);
const capabilityOf = (route: Route): VendorCapability | undefined =>
  (VENDOR_CAPABILITIES as readonly string[]).includes(route.capability)
    ? (route.capability as VendorCapability)
    : undefined;

/** The route's path with a fresh id for every parameter: the guards decide before any lookup. */
const pathOf = (route: Route) =>
  route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, () => crypto.randomUUID());

function call(
  route: Route,
  headers: (path: string) => Record<string, string>,
): Promise<request.Response> {
  const agent = request(httpServer(app));
  const path = pathOf(route);
  const pending =
    route.method === 'GET'
      ? agent.get(path)
      : route.method === 'POST'
        ? agent.post(path)
        : route.method === 'PUT'
          ? agent.put(path)
          : route.method === 'PATCH'
            ? agent.patch(path)
            : agent.delete(path);
  return pending.set(headers(path));
}

interface Expectation {
  readonly route: Route;
  /** Headers for the request's actual path (a signature covers the path). */
  readonly headers: (path: string) => Record<string, string>;
  readonly status: number;
  readonly code: string;
}

/** Makes every call (a few at a time); the ones without exactly the expected refusal, as lines. */
async function mismatches(expectations: readonly Expectation[]): Promise<string[]> {
  const found: string[] = [];
  const queue = [...expectations];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const response = await call(next.route, next.headers);
      const parsed = ApiError.safeParse(response.body);
      const code = parsed.success ? parsed.data.code : '(no API error)';
      if (response.status !== next.status || code !== next.code) {
        found.push(
          `${key(next.route)}: expected ${String(next.status)} ${next.code}, got ` +
            `${String(response.status)} ${code}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return found.sort();
}

describe('[INT-002] [SEC-003] the Control Plane route registry', () => {
  it('matches the controllers: same routes, each with the declared access', () => {
    const served: string[] = [];
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
        if (controller === null) continue;
        const base = (Reflect.getMetadata('path', controller) as string | undefined) ?? '';
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const path = Reflect.getMetadata('path', handler) as string | undefined;
          const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
          if (path === undefined || method === undefined) continue;
          // The handler's own marking, else the controller's (as the guards read them).
          const read = (metadata: string): unknown =>
            (Reflect.getMetadata(metadata, handler) as unknown) ??
            (Reflect.getMetadata(metadata, controller) as unknown);
          const vendor = read(VENDOR_ROUTE) as string | undefined;
          const access =
            read(PUBLIC_ROUTE) === true
              ? 'PUBLIC'
              : vendor === undefined
                ? 'INSTALLATION'
                : vendor === 'SESSION'
                  ? 'VENDOR'
                  : vendor;
          const full = `/${['v1', base, path]
            .flatMap((part) => part.split('/'))
            .filter((part) => part !== '')
            .join('/')}`;
          served.push(`${METHOD_NAMES[method] ?? String(method)} ${full} ${access}`);
        }
      }
    }
    const registered = routes.map((route) => `${key(route)} ${route.capability}`);
    expect(served.filter((route) => !registered.includes(route))).toEqual([]);
    expect(registered.filter((route) => !served.includes(route))).toEqual([]);
  });
});

describe('[SEC-017] [SEC-003] [SEC-018] the authorisation sweep over every endpoint', () => {
  it('covers the whole registry, and only the reviewed endpoints are open to anyone', () => {
    expect(routes.length).toBeGreaterThan(60);
    expect(routes.filter(isPublic).map(key).sort()).toEqual(PUBLIC_ROUTES);
  });

  it('refuses every other endpoint without a credential', async () => {
    const expected = routes
      .filter((route) => !isPublic(route))
      .map((route) => ({
        route,
        headers: () => ({}),
        status: 401,
        code: isVendor(route) ? 'VENDOR_UNAUTHENTICATED' : CONTROL_PLANE_ERRORS.signatureInvalid,
      }));
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[ADR-0012] keeps restaurant PCs and vendor staff to their own endpoints', async () => {
    const expected = [
      // A vendor session is not a restaurant PC's signature, even a Super Admin's.
      ...routes.filter(isInstallation).map((route) => ({
        route,
        headers: () => bearer(sessions.SUPER_ADMIN),
        status: 401,
        code: CONTROL_PLANE_ERRORS.signatureInvalid,
      })),
      // A restaurant PC's signature opens no vendor endpoint.
      ...routes.filter(isVendor).map((route) => ({
        route,
        headers: (path: string) => pc.headers(route.method, path),
        status: 401,
        code: 'VENDOR_UNAUTHENTICATED',
      })),
    ];
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[UPD-008] refuses a revoked restaurant PC on every endpoint of its own', async () => {
    const expected = routes.filter(isInstallation).map((route) => ({
      route,
      headers: (path: string) => revoked.headers(route.method, path),
      status: 403,
      code: CONTROL_PLANE_ERRORS.installationRevoked,
    }));
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[SEC-018] refuses each vendor role what its capabilities do not allow', async () => {
    const expected = routes.flatMap((route) => {
      const capability = capabilityOf(route);
      if (capability === undefined) return [];
      return VENDOR_ROLES.filter((role) => !vendorMay(role, capability)).map((role) => ({
        route,
        headers: () => bearer(sessions[role]),
        status: 403,
        code: 'FORBIDDEN',
      }));
    });
    expect(expected.length).toBeGreaterThan(100);
    expect(await mismatches(expected)).toEqual([]);
  });

  it('[SEC-018] refuses a signed-out vendor session everywhere', async () => {
    const token = await signInVendor(app, await vendorAccount(app, 'SUPER_ADMIN'));
    const out = await request(httpServer(app)).delete('/v1/vendor/session').set(bearer(token));
    expect(out.status).toBe(204);
    const expected = routes.filter(isVendor).map((route) => ({
      route,
      headers: () => bearer(token),
      status: 401,
      code: 'VENDOR_UNAUTHENTICATED',
    }));
    expect(await mismatches(expected)).toEqual([]);
  });
});
