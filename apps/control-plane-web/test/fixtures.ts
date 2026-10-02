import {
  type PlanView,
  type VendorInstallationView,
  type VendorInvoiceView,
  type VendorLicenceView,
  type VendorMeView,
  type VendorRole,
  type VendorTenantDetail,
  type VendorUserView,
  vendorCapabilitiesOf,
} from '@rp/contracts/control-plane';

export const TENANT_ID = '0190a1b2-0000-7000-8000-000000000001';
export const INSTALLATION_ID = '0190a1b2-0000-7000-8000-000000000002';
export const PENDING_ID = '0190a1b2-0000-7000-8000-000000000003';
export const USER_ID = '0190a1b2-0000-7000-8000-0000000000aa';

export function vendorUser(
  role: VendorRole,
  overrides: Partial<VendorUserView> = {},
): VendorUserView {
  return {
    id: USER_ID,
    email: 'asha@vendor.example',
    name: 'Asha Rao',
    role,
    active: true,
    disabled: false,
    lockedUntil: null,
    lastSignInAt: '2026-10-01T04:30:00.000Z',
    reviewedAt: null,
    createdAt: '2026-09-01T04:30:00.000Z',
    ...overrides,
  };
}

export function meView(role: VendorRole): VendorMeView {
  return {
    user: vendorUser(role),
    capabilities: [...vendorCapabilitiesOf(role)],
    expiresAt: '2026-10-02T12:30:00.000Z',
  };
}

export function installation(
  overrides: Partial<VendorInstallationView> = {},
): VendorInstallationView {
  return {
    id: INSTALLATION_ID,
    tenantId: TENANT_ID,
    name: 'Main counter PC',
    status: 'ACTIVE',
    channel: 'STABLE',
    enrolledAt: '2026-09-02T05:00:00.000Z',
    lastSeenAt: '2026-10-02T03:55:00.000Z',
    version: '1.4.0',
    licenceState: 'ACTIVE',
    ...overrides,
  };
}

export function tenantDetail(overrides: Partial<VendorTenantDetail> = {}): VendorTenantDetail {
  return {
    id: TENANT_ID,
    name: 'Spice Route',
    legalName: 'Spice Route Foods LLP',
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27',
    contactName: 'Kiran Shah',
    contactEmail: 'kiran@spiceroute.example',
    contactPhone: '+91 98200 00000',
    installations: 2,
    licenceState: 'GRACE',
    createdAt: '2026-09-01T05:00:00.000Z',
    installationList: [
      installation(),
      installation({
        id: PENDING_ID,
        name: 'Kitchen PC',
        status: 'PENDING',
        enrolledAt: null,
        lastSeenAt: null,
        version: null,
        licenceState: null,
      }),
    ],
    ...overrides,
  };
}

export function licence(overrides: Partial<VendorLicenceView> = {}): VendorLicenceView {
  return {
    installationId: INSTALLATION_ID,
    state: 'GRACE',
    reason: 'Invoice SUB/2026-27/00001 overdue',
    plan: 'Standard',
    modules: ['POS', 'KDS', 'WAITER_APP'],
    deviceLimits: { TABLE_TABLET: 12, PAGER: 6, WAITER_PHONE: 6, KDS: 2 },
    validityDays: 30,
    graceDays: 7,
    graceStartedAt: '2026-10-01T00:00:00.000Z',
    boundAt: '2026-09-02T05:00:00.000Z',
    latest: {
      id: '0190a1b2-0000-7000-8000-0000000000f1',
      issuedAt: '2026-10-02T03:55:00.000Z',
      validUntil: '2026-11-01T03:55:00.000Z',
      state: 'GRACE',
    },
    ...overrides,
  };
}

export const PLAN_ID = '0190a1b2-0000-7000-8000-0000000000b1';
export const INVOICE_ID = '0190a1b2-0000-7000-8000-0000000000c1';

export function plan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    id: PLAN_ID,
    code: 'STANDARD',
    name: 'Standard',
    prices: { MONTHLY: 2_49_900, QUARTERLY: null, YEARLY: 24_99_000 },
    deviceLimits: { TABLE_TABLET: 12, PAGER: 6, WAITER_PHONE: 6, KDS: 2 },
    modules: ['POS', 'KDS', 'WAITER_APP'],
    archivedAt: null,
    subscribers: 1,
    ...overrides,
  };
}

export function invoice(overrides: Partial<VendorInvoiceView> = {}): VendorInvoiceView {
  return {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    tenantName: 'Spice Route',
    number: 'SUB/2026-27/00001',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    amount: 2_49_900,
    paid: 1_00_000,
    dueOn: '2026-09-08',
    status: 'ISSUED',
    daysOverdue: 24,
    issuedAt: '2026-09-01T06:30:00.000Z',
    paidAt: null,
    voidReason: null,
    ...overrides,
  };
}
