import { Card, Table } from '@rp/ui-web';
import { when, whenOrDash } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { useApi } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { AlertsTable } from './AlertsTable.js';
import { diskShown } from './fleet-view.js';
import { BackupText, CloudBackupText, ChainText, OnlineBadge } from './PcHealth.js';

/**
 * One PC's health from its latest heartbeat (VCP-005), its alerts, open and closed, and the audit
 * chain heads it reported (AUD-003).
 */
export function InstallationHealth({ installationId }: { installationId: string }) {
  const t = useT();
  const api = useApi();
  const fleet = useLoad((signal) => api.getFleet({ signal }), `fleet:${installationId}`);
  const alerts = useLoad(
    (signal) => api.listFleetAlerts({ query: { state: 'ALL', installationId }, signal }),
    `alerts:${installationId}`,
  );
  const heads = useLoad(
    (signal) => api.listAuditHeads({ params: { id: installationId }, signal }),
    `heads:${installationId}`,
  );
  const reload = () => {
    fleet.reload();
    alerts.reload();
    heads.reload();
  };

  return (
    <>
      <Card title={t('vendorApp.fleet.health')} headingLevel={2}>
        <LoadView data={fleet.data} reload={fleet.reload} failed={t('vendorApp.fleet.loadFailed')}>
          {({ installations }) => {
            const pc = installations.find((entry) => entry.installationId === installationId);
            if (pc?.lastSeenAt === undefined || pc.lastSeenAt === null) {
              return <p className="cp-hint">{t('vendorApp.fleet.noReport')}</p>;
            }
            const disk = diskShown(pc);
            return (
              <dl className="cp-facts">
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.state')}</dt>
                  <dd>
                    <OnlineBadge pc={pc} />{' '}
                    {t('vendorApp.fleet.lastHeard', { at: when(pc.lastSeenAt) })}
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.components')}</dt>
                  <dd>
                    {pc.components
                      .map((component) =>
                        t('vendorApp.fleet.component', {
                          name: component.name,
                          version: component.version,
                        }),
                      )
                      .join(', ')}
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.disk')}</dt>
                  <dd>
                    {disk === null
                      ? '—'
                      : t('vendorApp.fleet.diskDetail', {
                          percent: disk.percent,
                          free: disk.freeGb,
                        })}
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.backup')}</dt>
                  <dd>
                    <BackupText pc={pc} />
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.cloudBackup')}</dt>
                  <dd>
                    <CloudBackupText pc={pc} />
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.devices')}</dt>
                  <dd>
                    {pc.devices.length === 0
                      ? t('vendorApp.fleet.noDevices')
                      : pc.devices
                          .map((device) =>
                            device.connected === null
                              ? t('vendorApp.fleet.deviceTypePaired', {
                                  type: device.type,
                                  paired: device.paired,
                                })
                              : t('vendorApp.fleet.deviceType', {
                                  type: device.type,
                                  connected: device.connected,
                                  paired: device.paired,
                                }),
                          )
                          .join(', ')}
                  </dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.errors')}</dt>
                  <dd>{pc.errorCount === null ? '—' : String(pc.errorCount)}</dd>
                </div>
                <div className="cp-facts__row">
                  <dt>{t('vendorApp.fleet.chain')}</dt>
                  <dd>
                    <ChainText pc={pc} />
                  </dd>
                </div>
              </dl>
            );
          }}
        </LoadView>
      </Card>
      <Card title={t('vendorApp.fleet.alerts')} headingLevel={2}>
        <LoadView
          data={alerts.data}
          reload={alerts.reload}
          failed={t('vendorApp.fleet.alertsFailed')}
        >
          {({ alerts: list }) => (
            <AlertsTable
              alerts={list}
              caption={t('vendorApp.fleet.alerts')}
              empty={t('vendorApp.fleet.noAlertsHere')}
              showPlace={false}
              onResolved={reload}
            />
          )}
        </LoadView>
      </Card>
      <Card title={t('vendorApp.fleet.chainHistory')} headingLevel={2}>
        <p className="cp-hint">{t('vendorApp.fleet.chainIntro')}</p>
        <LoadView data={heads.data} reload={heads.reload} failed={t('vendorApp.fleet.chainFailed')}>
          {({ heads: list }) => (
            <Table
              caption={t('vendorApp.fleet.chainHistory')}
              hideCaption
              rows={list}
              rowKey={(head) => `${String(head.sequence)}:${head.firstSeenAt}`}
              empty={t('vendorApp.fleet.chainNone')}
              columns={[
                {
                  key: 'sequence',
                  header: t('vendorApp.fleet.entry'),
                  align: 'end',
                  cell: (head) => String(head.sequence),
                },
                {
                  key: 'hash',
                  header: t('vendorApp.fleet.fingerprint'),
                  cell: (head) => <code title={head.hash}>{head.hash.slice(0, 12)}…</code>,
                },
                {
                  key: 'seen',
                  header: t('vendorApp.fleet.firstSeen'),
                  cell: (head) => when(head.firstSeenAt),
                },
                {
                  key: 'verified',
                  header: t('vendorApp.fleet.verified'),
                  cell: (head) =>
                    head.superseded ? t('vendorApp.fleet.setAside') : whenOrDash(head.verifiedAt),
                },
              ]}
            />
          )}
        </LoadView>
      </Card>
    </>
  );
}
