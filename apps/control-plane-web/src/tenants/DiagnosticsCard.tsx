import type { VendorDiagnosticsDetail } from '@rp/contracts/control-plane';
import { Button, Card, Dialog, Table } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';

/** Bytes as kilobytes, for the list. */
export function kilobytes(bytes: number): string {
  return Math.max(1, Math.round(bytes / 1_024)).toString();
}

function BundleView({ detail }: { detail: VendorDiagnosticsDetail }) {
  const t = useT();
  const { bundle } = detail;
  return (
    <div className="cp-diagnostics">
      <dl className="cp-facts">
        <div className="cp-facts__row">
          <dt>{t('vendorApp.diagnostics.made')}</dt>
          <dd>{when(bundle.generatedAt)}</dd>
        </div>
        <div className="cp-facts__row">
          <dt>{t('vendorApp.fleet.components')}</dt>
          <dd>
            {bundle.versions
              .map((entry) =>
                t('vendorApp.fleet.component', { name: entry.name, version: entry.version }),
              )
              .join(', ')}
          </dd>
        </div>
        <div className="cp-facts__row">
          <dt>{t('vendorApp.diagnostics.platform')}</dt>
          <dd>
            {t('vendorApp.diagnostics.platformText', {
              os: bundle.platform.os,
              release: bundle.platform.release,
              cpus: bundle.platform.cpus,
              memory: bundle.platform.memoryMb,
            })}
          </dd>
        </div>
      </dl>
      <h3 className="cp-section__title">{t('vendorApp.diagnostics.configuration')}</h3>
      <pre className="cp-pre">{JSON.stringify(bundle.configuration, null, 2)}</pre>
      <h3 className="cp-section__title">{t('vendorApp.diagnostics.devices')}</h3>
      <Table
        caption={t('vendorApp.diagnostics.devices')}
        hideCaption
        rows={bundle.devices}
        rowKey={(device) => `${device.type}:${device.name}`}
        empty={t('vendorApp.fleet.noDevices')}
        columns={[
          { key: 'type', header: t('vendorApp.diagnostics.type'), cell: (device) => device.type },
          { key: 'name', header: t('vendorApp.installation.name'), cell: (device) => device.name },
          {
            key: 'status',
            header: t('vendorApp.installation.status'),
            cell: (device) => device.status,
          },
          {
            key: 'online',
            header: t('vendorApp.fleet.state'),
            cell: (device) =>
              device.online ? t('vendorApp.fleet.online') : t('vendorApp.fleet.offline'),
          },
          {
            key: 'version',
            header: t('vendorApp.installation.version'),
            cell: (device) => device.appVersion ?? '—',
          },
        ]}
      />
      <h3 className="cp-section__title">{t('vendorApp.diagnostics.settings')}</h3>
      <pre className="cp-pre">{JSON.stringify(bundle.settings, null, 2)}</pre>
      <h3 className="cp-section__title">{t('vendorApp.diagnostics.status')}</h3>
      <pre className="cp-pre">{JSON.stringify(bundle.status, null, 2)}</pre>
      {bundle.logs.files.map((file) => (
        <section key={file.name} aria-label={t('vendorApp.diagnostics.log', { name: file.name })}>
          <h3 className="cp-section__title">
            {t('vendorApp.diagnostics.log', { name: file.name })}
          </h3>
          <pre className="cp-pre cp-pre--log">{file.lines.join('\n')}</pre>
        </section>
      ))}
      {bundle.logs.truncated ? (
        <p className="cp-hint">{t('vendorApp.diagnostics.truncated')}</p>
      ) : null}
    </div>
  );
}

/**
 * Diagnostics bundles a PC's manager sent (UPD-008, VCP-007): listed for every role; opened only
 * by Support, Onboarding or the Super Admin, and every opening is audited (the access policy).
 */
export function DiagnosticsCard({ installationId }: { installationId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const { data, reload } = useLoad(
    (signal) => api.listVendorDiagnostics({ params: { id: installationId }, signal }),
    `diagnostics:${installationId}`,
  );
  const [opening, setOpening] = useState<string | undefined>();
  const [detail, setDetail] = useState<VendorDiagnosticsDetail | undefined>();
  const [error, setError] = useState<string | undefined>();

  return (
    <Card title={t('vendorApp.diagnostics.title')} headingLevel={2}>
      <p className="cp-hint">{t('vendorApp.diagnostics.intro')}</p>
      <LoadView data={data} reload={reload} failed={t('vendorApp.diagnostics.loadFailed')}>
        {({ bundles }) => (
          <Table
            caption={t('vendorApp.diagnostics.title')}
            hideCaption
            rows={bundles}
            rowKey={(bundle) => bundle.id}
            empty={t('vendorApp.diagnostics.none')}
            columns={[
              {
                key: 'at',
                header: t('vendorApp.diagnostics.received'),
                cell: (bundle) => when(bundle.receivedAt),
              },
              {
                key: 'by',
                header: t('vendorApp.diagnostics.sentBy'),
                cell: (bundle) =>
                  bundle.sentBy === null
                    ? '—'
                    : t('vendorApp.diagnostics.sender', {
                        name: bundle.sentBy.name,
                        role: bundle.sentBy.role,
                      }),
              },
              {
                key: 'note',
                header: t('vendorApp.diagnostics.note'),
                cell: (bundle) => bundle.note ?? '—',
              },
              {
                key: 'size',
                header: t('vendorApp.diagnostics.size'),
                align: 'end',
                cell: (bundle) =>
                  t('vendorApp.diagnostics.kb', { size: kilobytes(bundle.sizeBytes) }),
              },
              ...(may('SUPPORT_NOTES')
                ? [
                    {
                      key: 'open',
                      header: t('vendorApp.actions.header'),
                      cell: (bundle: { id: string; receivedAt: string }) => (
                        <Button
                          variant="secondary"
                          loading={opening === bundle.id}
                          aria-label={t('vendorApp.diagnostics.openFrom', {
                            at: when(bundle.receivedAt),
                          })}
                          onClick={() => {
                            setOpening(bundle.id);
                            setError(undefined);
                            api.getVendorDiagnostics({ params: { id: bundle.id } }).then(
                              (opened) => {
                                setOpening(undefined);
                                setDetail(opened);
                              },
                              (failure: unknown) => {
                                setOpening(undefined);
                                setError(messageOf(failure, t));
                              },
                            );
                          }}
                        >
                          {t('vendorApp.diagnostics.open')}
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </LoadView>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
      <Dialog
        open={detail !== undefined}
        size="lg"
        onClose={() => {
          setDetail(undefined);
        }}
        title={t('vendorApp.diagnostics.viewTitle', {
          at: detail === undefined ? '' : when(detail.receivedAt),
        })}
        description={t('vendorApp.diagnostics.viewIntro')}
      >
        {detail === undefined ? null : <BundleView detail={detail} />}
      </Dialog>
    </Card>
  );
}
