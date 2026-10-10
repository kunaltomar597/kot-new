import type { VendorRole } from '@rp/contracts/control-plane';
import { createTranslator } from '@rp/i18n';
import { render, type RenderResult } from '@testing-library/react';
import { type UserEvent, userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router';
import { expect } from 'vitest';
import { App } from '../src/App.js';
import { createServices, type Services } from '../src/app/services.js';
import { StepUpPrompt } from '../src/app/step-up.js';
import type { TokenStorage } from '../src/app/session.js';
import { FakeControlPlane, FakeRefusal } from './fake-cp.js';
import {
  fleetPc,
  INSTALLATION_ID,
  licence,
  meView,
  REMOTE_DEFINITIONS,
  tenantDetail,
} from './fixtures.js';

/** Answers the authenticator question at once, as a person with the app at hand would. */
function answeringStepUp(): StepUpPrompt {
  const prompt = new StepUpPrompt();
  prompt.ask = () => Promise.resolve('123456');
  return prompt;
}

/** Session storage for a test: starts with a token when someone is signed in. */
export function memoryStorage(token?: string): TokenStorage & { value: string | undefined } {
  const storage = {
    value: token,
    read: () => storage.value,
    write: (next: string | undefined) => {
      storage.value = next;
    },
  };
  return storage;
}

/** A Control Plane with one restaurant (two PCs), its licence, no notes and no QR relay yet. */
export function controlPlane(role?: VendorRole): FakeControlPlane {
  const cp = new FakeControlPlane();
  cp.role = role;
  const detail = tenantDetail();
  cp.on('vendorMe', () => {
    if (cp.role === undefined) throw new FakeRefusal(401, 'VENDOR_UNAUTHENTICATED', 'Sign in.');
    return meView(cp.role);
  })
    .on('vendorSignOut', () => undefined)
    .on('listVendorTenants', () => ({
      tenants: [(({ installationList: _list, ...view }) => view)(detail)],
    }))
    .on('getVendorTenant', () => detail)
    .on('getVendorInstallation', ({ params }) => {
      const found = detail.installationList.find((entry) => entry.id === params.id);
      if (found === undefined) throw new FakeRefusal(404, 'NOT_FOUND', 'No such installation.');
      return found;
    })
    .on('getVendorLicence', () => licence())
    .on('listSupportNotes', () => ({ notes: [] }))
    .on('getRelayProvisioning', () => {
      throw new FakeRefusal(404, 'NOT_FOUND', 'Not provisioned in the QR relay yet.');
    })
    .on('getFleet', () => ({ installations: [fleetPc()], generatedAt: '2026-10-02T04:00:00.000Z' }))
    .on('listFleetAlerts', () => ({ alerts: [] }))
    .on('listAuditHeads', () => ({ heads: [] }))
    .on('getInstallationAvailability', ({ params }) => ({
      installationId: params.id,
      timeZone: 'Asia/Kolkata',
      from: '2026-10-01',
      to: '2026-10-02',
      targetBp: 9_990,
      meetsTarget: null,
      totals: { openMinutes: 0, downMinutes: 0, availabilityBp: null },
      days: [],
    }))
    .on('listVendorDiagnostics', () => ({ bundles: [] }))
    .on('listVendorDiagnosticsRequests', () => ({ requests: [] }))
    .on('listVendorCloudBackups', () => ({ backups: [] }))
    .on('getFleetRemoteSettings', () => ({
      definitions: REMOTE_DEFINITIONS,
      fleet: {},
      updatedAt: null,
    }))
    .on('getInstallationRemoteSettings', () => ({
      installationId: INSTALLATION_ID,
      fleet: {},
      overrides: {},
      effective: {},
      digest: '0000000000000000',
      appliedDigest: '0000000000000000',
      updatedAt: null,
    }));
  return cp;
}

/** Renders the whole app at `path`, signed in as `role` (or signed out). */
export function renderApp({
  cp,
  path = '/',
  signedIn = cp.role !== undefined,
}: {
  cp: FakeControlPlane;
  path?: string;
  signedIn?: boolean;
}): RenderResult & {
  user: UserEvent;
  storage: ReturnType<typeof memoryStorage>;
  services: Services;
} {
  const storage = memoryStorage(signedIn ? 'session-token' : undefined);
  const services = createServices({
    baseUrl: '',
    storage,
    fetch: cp.fetch,
    stepUp: answeringStepUp(),
  });
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} translator={createTranslator()} />
    </MemoryRouter>,
  );
  return { ...view, user, storage, services };
}

export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}
