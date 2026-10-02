import type { VendorTenantView } from '@rp/contracts/control-plane';
import { Button, Table, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LicenceBadge } from '../components/LicenceBadge.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { TenantDialog } from './TenantForm.js';

/** Restaurants whose name, legal name, GSTIN or contact contain the search, ignoring case. */
export function searchTenants(
  tenants: readonly VendorTenantView[],
  search: string,
): VendorTenantView[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tenants];
  return tenants.filter((tenant) => {
    const text = [
      tenant.name,
      tenant.legalName,
      tenant.gstin,
      tenant.contactName,
      tenant.contactEmail,
      tenant.contactPhone,
    ]
      .filter((value) => value !== null)
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Every restaurant with its PCs and most severe licence state (VCP-002). */
export function TenantsScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, reload } = useLoad((signal) => api.listVendorTenants({ signal }), 'tenants');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  return (
    <Page
      title={t('vendorApp.tenants.title')}
      intro={t('vendorApp.tenants.intro')}
      actions={
        may('TENANTS_MANAGE') ? (
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('vendorApp.tenants.add')}
          </Button>
        ) : undefined
      }
    >
      <LoadView data={data} reload={reload} failed={t('vendorApp.tenants.loadFailed')}>
        {({ tenants }) => (
          <>
            <div className="cp-toolbar">
              <TextField
                label={t('vendorApp.tenants.search')}
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <Table
              caption={t('vendorApp.tenants.title')}
              hideCaption
              rows={searchTenants(tenants, search)}
              rowKey={(tenant) => tenant.id}
              empty={
                tenants.length === 0 ? t('vendorApp.tenants.empty') : t('vendorApp.tenants.noMatch')
              }
              columns={[
                {
                  key: 'name',
                  header: t('vendorApp.tenant.field.name'),
                  cell: (tenant) => (
                    <Link className="cp-link" to={`/restaurants/${tenant.id}`}>
                      {tenant.name}
                    </Link>
                  ),
                },
                {
                  key: 'gstin',
                  header: t('vendorApp.tenant.field.gstin'),
                  cell: (tenant) => tenant.gstin ?? '—',
                },
                {
                  key: 'contact',
                  header: t('vendorApp.tenant.field.contactName'),
                  cell: (tenant) => tenant.contactName,
                },
                {
                  key: 'pcs',
                  header: t('vendorApp.tenants.pcs'),
                  align: 'end',
                  cell: (tenant) => String(tenant.installations),
                },
                {
                  key: 'licence',
                  header: t('vendorApp.tenants.licence'),
                  cell: (tenant) => <LicenceBadge state={tenant.licenceState} />,
                },
                {
                  key: 'added',
                  header: t('vendorApp.tenants.added'),
                  cell: (tenant) => when(tenant.createdAt),
                },
              ]}
            />
          </>
        )}
      </LoadView>
      {adding ? (
        <TenantDialog
          open
          onClose={() => {
            setAdding(false);
          }}
          onSave={async (request) => {
            const created = await api.createVendorTenant({ body: request });
            setAdding(false);
            toast.show({
              title: t('vendorApp.tenants.created', { name: created.name }),
              tone: 'success',
            });
            void navigate(`/restaurants/${created.id}`);
          }}
        />
      ) : null}
    </Page>
  );
}
