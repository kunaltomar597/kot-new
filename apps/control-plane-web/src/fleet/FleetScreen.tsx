import { Badge, Button, Select, Table } from '@rp/ui-web';
import { useState } from 'react';
import { Link } from 'react-router';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { useApi } from '../app/services.js';
import { useEvery } from '../app/use-every.js';
import { useLoad } from '../app/use-load.js';
import { LicenceBadge } from '../components/LicenceBadge.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { ALERT_TONE, AlertsTable } from './AlertsTable.js';
import {
  deviceTotals,
  diskShown,
  FLEET_FILTERS,
  type FleetFilter,
  filterFleet,
  fleetSummary,
  productVersion,
} from './fleet-view.js';
import { BackupText, ChainText, OnlineBadge } from './PcHealth.js';

const REFRESH_MS = 60_000;

/**
 * The fleet at a glance (VCP-005, NFR-O03): open alerts first, then every PC's health from its
 * latest heartbeat. Refreshes every minute.
 */
export function FleetScreen() {
  const t = useT();
  const api = useApi();
  const fleet = useLoad((signal) => api.getFleet({ signal }), 'fleet');
  const alerts = useLoad(
    (signal) => api.listFleetAlerts({ query: { state: 'OPEN' }, signal }),
    'alerts',
  );
  const [filter, setFilter] = useState<FleetFilter>('ALL');
  const reloadFleet = fleet.reload;
  const reloadAlerts = alerts.reload;
  const refresh = () => {
    reloadFleet();
    reloadAlerts();
  };
  useEvery(reloadFleet, REFRESH_MS);
  useEvery(reloadAlerts, REFRESH_MS);

  return (
    <Page
      title={t('vendorApp.fleet.title')}
      intro={t('vendorApp.fleet.intro')}
      actions={
        <Button variant="secondary" onClick={refresh}>
          {t('vendorApp.fleet.refresh')}
        </Button>
      }
    >
      <section className="cp-section" aria-labelledby="cp-fleet-alerts">
        <h2 id="cp-fleet-alerts" className="cp-section__title">
          {t('vendorApp.fleet.openAlerts')}
        </h2>
        <LoadView
          data={alerts.data}
          reload={reloadAlerts}
          failed={t('vendorApp.fleet.alertsFailed')}
        >
          {({ alerts: open }) => (
            <AlertsTable
              alerts={open}
              caption={t('vendorApp.fleet.openAlerts')}
              empty={t('vendorApp.fleet.noAlerts')}
              onResolved={refresh}
            />
          )}
        </LoadView>
      </section>
      <section className="cp-section" aria-labelledby="cp-fleet-pcs">
        <h2 id="cp-fleet-pcs" className="cp-section__title">
          {t('vendorApp.fleet.pcs')}
        </h2>
        <LoadView data={fleet.data} reload={reloadFleet} failed={t('vendorApp.fleet.loadFailed')}>
          {({ installations, generatedAt }) => {
            const summary = fleetSummary(installations);
            return (
              <>
                <p className="cp-hint">
                  {t('vendorApp.fleet.summary', {
                    online: summary.online,
                    active: summary.active,
                    alerts: summary.alerts,
                    at: when(generatedAt),
                  })}
                </p>
                <div className="cp-toolbar">
                  <Select
                    label={t('vendorApp.fleet.show')}
                    value={filter}
                    options={FLEET_FILTERS.map((value) => ({
                      value,
                      label: t(`vendorApp.fleet.filter.${value}`),
                    }))}
                    onChange={(event) => {
                      setFilter(event.target.value as FleetFilter);
                    }}
                  />
                </div>
                <Table
                  caption={t('vendorApp.fleet.pcs')}
                  hideCaption
                  rows={filterFleet(installations, filter)}
                  rowKey={(pc) => pc.installationId}
                  empty={t('vendorApp.fleet.noPcs')}
                  columns={[
                    {
                      key: 'pc',
                      header: t('vendorApp.fleet.where'),
                      cell: (pc) => (
                        <Link className="cp-link" to={`/installations/${pc.installationId}`}>
                          {t('vendorApp.fleet.place', {
                            tenant: pc.tenantName,
                            pc: pc.installationName,
                          })}
                        </Link>
                      ),
                    },
                    {
                      key: 'online',
                      header: t('vendorApp.fleet.state'),
                      cell: (pc) => (
                        <>
                          <OnlineBadge pc={pc} />
                          {pc.lastSeenAt === null ? null : (
                            <span className="cp-hint"> {when(pc.lastSeenAt)}</span>
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'version',
                      header: t('vendorApp.installation.version'),
                      cell: (pc) => productVersion(pc) ?? '—',
                    },
                    {
                      key: 'disk',
                      header: t('vendorApp.fleet.disk'),
                      align: 'end',
                      cell: (pc) => {
                        const disk = diskShown(pc);
                        return disk === null
                          ? '—'
                          : t('vendorApp.fleet.percent', { percent: disk.percent });
                      },
                    },
                    {
                      key: 'backup',
                      header: t('vendorApp.fleet.backup'),
                      cell: (pc) => <BackupText pc={pc} />,
                    },
                    {
                      key: 'devices',
                      header: t('vendorApp.fleet.devices'),
                      cell: (pc) => {
                        const totals = deviceTotals(pc);
                        return totals.connected === null
                          ? t('vendorApp.fleet.devicesPaired', { paired: totals.paired })
                          : t('vendorApp.fleet.devicesConnected', {
                              connected: totals.connected,
                              paired: totals.paired,
                            });
                      },
                    },
                    {
                      key: 'errors',
                      header: t('vendorApp.fleet.errors'),
                      align: 'end',
                      cell: (pc) => (pc.errorCount === null ? '—' : String(pc.errorCount)),
                    },
                    {
                      key: 'licence',
                      header: t('vendorApp.tenants.licence'),
                      cell: (pc) => <LicenceBadge state={pc.licenceState} />,
                    },
                    {
                      key: 'chain',
                      header: t('vendorApp.fleet.chain'),
                      cell: (pc) => <ChainText pc={pc} />,
                    },
                    {
                      key: 'alerts',
                      header: t('vendorApp.fleet.alerts'),
                      cell: (pc) =>
                        pc.openAlerts.length === 0 ? (
                          '—'
                        ) : (
                          <span className="cp-badges">
                            {pc.openAlerts.map((kind) => (
                              <Badge key={kind} tone={ALERT_TONE[kind]}>
                                {t(`vendorApp.fleet.kind.${kind}`)}
                              </Badge>
                            ))}
                          </span>
                        ),
                    },
                  ]}
                />
              </>
            );
          }}
        </LoadView>
      </section>
    </Page>
  );
}
