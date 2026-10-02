import type { VendorTenantDetail } from '@rp/contracts/control-plane';
import { Button, Tabs, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LicenceBadge } from '../components/LicenceBadge.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { SubscriptionPanel } from '../billing/SubscriptionPanel.js';
import { InstallationsPanel } from './InstallationsPanel.js';
import { NotesPanel } from './NotesPanel.js';
import { RelayPanel } from './RelayPanel.js';
import { TenantDialog } from './TenantForm.js';

function Details({ tenant }: { tenant: VendorTenantDetail }) {
  const t = useT();
  const rows = [
    ['legalName', tenant.legalName],
    ['gstin', tenant.gstin],
    ['stateCode', tenant.stateCode],
    ['contactName', tenant.contactName],
    ['contactEmail', tenant.contactEmail],
    ['contactPhone', tenant.contactPhone],
  ] as const;
  return (
    <dl className="cp-facts">
      {rows.map(([field, value]) => (
        <div key={field} className="cp-facts__row">
          <dt>{t(`vendorApp.tenant.field.${field}`)}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One restaurant: its details, PCs, support notes and QR ordering (VCP-002, VCP-007). */
export function TenantScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const id = useParams().id ?? '';
  const { data, reload } = useLoad(
    (signal) => api.getVendorTenant({ params: { id }, signal }),
    `tenant:${id}`,
  );
  const [editing, setEditing] = useState(false);
  const back = (
    <Link className="cp-link cp-back" to="/restaurants">
      {t('vendorApp.tenants.back')}
    </Link>
  );

  return (
    <LoadView data={data} reload={reload} failed={t('vendorApp.tenant.loadFailed')}>
      {(tenant) => (
        <Page
          back={back}
          title={tenant.name}
          intro={<LicenceBadge state={tenant.licenceState} />}
          actions={
            may('TENANTS_MANAGE') ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                {t('vendorApp.tenant.edit')}
              </Button>
            ) : undefined
          }
        >
          <Tabs
            label={t('vendorApp.tenant.sections')}
            items={[
              {
                id: 'details',
                label: t('vendorApp.tenant.tab.details'),
                content: <Details tenant={tenant} />,
              },
              {
                id: 'pcs',
                label: t('vendorApp.tenant.tab.pcs'),
                content: <InstallationsPanel tenant={tenant} onChange={reload} />,
              },
              {
                id: 'subscription',
                label: t('vendorApp.tenant.tab.subscription'),
                content: <SubscriptionPanel tenantId={tenant.id} />,
              },
              {
                id: 'notes',
                label: t('vendorApp.tenant.tab.notes'),
                content: <NotesPanel tenantId={tenant.id} />,
              },
              {
                id: 'relay',
                label: t('vendorApp.tenant.tab.relay'),
                content: <RelayPanel tenantId={tenant.id} />,
              },
            ]}
          />
          {editing ? (
            <TenantDialog
              open
              tenant={tenant}
              onClose={() => {
                setEditing(false);
              }}
              onSave={async (request) => {
                await api.updateVendorTenant({ params: { id: tenant.id }, body: request });
                setEditing(false);
                toast.show({ title: t('vendorApp.tenant.saved'), tone: 'success' });
                reload();
              }}
            />
          ) : null}
        </Page>
      )}
    </LoadView>
  );
}
