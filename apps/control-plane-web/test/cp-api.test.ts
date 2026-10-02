import { describe, expect, it, vi } from 'vitest';
import { CpApiError, CpUnavailableError, createCpApi } from '../src/app/cp-api.js';
import { FakeControlPlane, FakeRefusal } from './fake-cp.js';
import { TENANT_ID, tenantDetail } from './fixtures.js';

describe('the Control Plane client', () => {
  it('[VCP-001] fills in path parameters and the query, sends the token, parses the answer', async () => {
    const cp = new FakeControlPlane();
    cp.role = 'FINANCE';
    cp.on('getVendorTenant', () => tenantDetail()).on('listVendorInvoices', () => ({
      invoices: [],
    }));
    const api = createCpApi({ baseUrl: '', fetch: cp.fetch, token: () => 'secret' });
    expect((await api.getVendorTenant({ params: { id: TENANT_ID } })).name).toBe('Spice Route');
    await api.listVendorInvoices({ query: { tenantId: TENANT_ID, status: 'OVERDUE' } });
    expect(cp.calls.map((call) => [call.operationId, call.params, call.query])).toEqual([
      ['getVendorTenant', { id: TENANT_ID }, {}],
      ['listVendorInvoices', {}, { tenantId: TENANT_ID, status: 'OVERDUE' }],
    ]);
  });

  it('[SEC-003] turns a refusal into an error with its code, and a 401 ends the session', async () => {
    const cp = new FakeControlPlane();
    cp.role = 'READ_ONLY';
    const over = vi.fn();
    const api = createCpApi({
      baseUrl: '',
      fetch: cp.fetch,
      token: () => 'secret',
      onSessionOver: over,
    });
    const forbidden = await api.runBilling().catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(CpApiError);
    expect(forbidden).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(over).not.toHaveBeenCalled();
    cp.role = undefined;
    await expect(api.vendorMe()).rejects.toMatchObject({ status: 401 });
    expect(over).toHaveBeenCalledOnce();
  });

  it('[VCP-001] never ends a session over a refused sign-in, and answers 204 with nothing', async () => {
    const cp = new FakeControlPlane();
    const over = vi.fn();
    cp.on('vendorSignIn', () => {
      throw new FakeRefusal(401, 'VENDOR_SIGN_IN_FAILED', 'Wrong email, password or code.');
    }).on('vendorSignOut', () => undefined);
    const api = createCpApi({
      baseUrl: '',
      fetch: cp.fetch,
      token: () => undefined,
      onSessionOver: over,
    });
    await expect(
      api.vendorSignIn({ body: { email: 'a@b.example', password: 'x', code: '123456' } }),
    ).rejects.toThrow('Wrong email, password or code.');
    expect(over).not.toHaveBeenCalled();
    cp.role = 'SUPPORT';
    const signedOut = createCpApi({ baseUrl: '', fetch: cp.fetch, token: () => 't' });
    await expect(signedOut.vendorSignOut()).resolves.toBeUndefined();
  });

  it('says when the Control Plane cannot be reached', async () => {
    const api = createCpApi({
      baseUrl: '',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      token: () => undefined,
    });
    const error = await api.getControlPlaneHealth().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CpUnavailableError);
    expect(error).toMatchObject({ reason: 'network' });
  });

  it('refuses an answer that does not match the contract', async () => {
    const api = createCpApi({
      baseUrl: '',
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ tenants: 'nope' }), { status: 200 })),
      token: () => 't',
    });
    await expect(api.listVendorTenants()).rejects.toThrow();
  });
});
