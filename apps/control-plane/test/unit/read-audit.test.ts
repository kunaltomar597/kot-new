import { CONTROL_PLANE_ROUTES } from '@rp/contracts/control-plane';
import { describe, expect, it } from 'vitest';

/**
 * Which vendor reads show a restaurant's business data, and so are audited (CP-R1, SEC-018's
 * "all production access"). Everything else is the Control Plane's own records: fleet state,
 * licences, versions, billing, notes. A new read route must be put in one list on purpose.
 */
const AUDITED_READS = new Set(['getVendorDiagnostics']);
const RECORDS_OF_THE_CONTROL_PLANE = new Set([
  'vendorMe',
  'listVendorUsers',
  'listVendorTenants',
  'getVendorTenant',
  'getVendorInstallation',
  'getVendorLicence',
  'listVendorReleases',
  'listVendorAudit',
  'listPlans',
  'getSubscription',
  'listVendorInvoices',
  'listSupportNotes',
  'getRelayProvisioning',
  'getFleet',
  'listFleetAlerts',
  'listAuditHeads',
  'listVendorCloudBackups',
  'listVendorDiagnostics',
  'listVendorDiagnosticsRequests',
  'getFleetRemoteSettings',
  'getInstallationRemoteSettings',
]);

describe('[SEC-018] [VCP-001] reads of a restaurant’s data are audited (CP-R1)', () => {
  it('has a decision for every vendor read', () => {
    const reads = CONTROL_PLANE_ROUTES.filter(
      (route) =>
        route.method === 'GET' &&
        route.capability !== 'PUBLIC' &&
        route.capability !== 'INSTALLATION',
    ).map((route) => route.operationId as string);
    const decided = new Set([...AUDITED_READS, ...RECORDS_OF_THE_CONTROL_PLANE]);
    expect(reads.filter((id) => !decided.has(id))).toEqual([]);
    expect([...decided].filter((id) => !reads.includes(id))).toEqual([]);
  });
});
