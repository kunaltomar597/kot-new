import { Badge, Button, Card, Table, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { RemoteSettingsEditor, shownValue } from './RemoteSettingsEditor.js';

/** One PC's vendor settings: the fleet's, its own, and whether it holds them yet (UPD-010). */
export function RemoteSettingsCard({ installationId }: { installationId: string }) {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const definitions = useLoad((signal) => api.getFleetRemoteSettings({ signal }), 'remote');
  const pc = useLoad(
    (signal) => api.getInstallationRemoteSettings({ params: { id: installationId }, signal }),
    `remote:${installationId}`,
  );
  const [editing, setEditing] = useState(false);

  return (
    <Card
      title={t('vendorApp.remote.title')}
      headingLevel={2}
      actions={
        may('REMOTE_CONFIG') &&
        definitions.data.status === 'ready' &&
        pc.data.status === 'ready' ? (
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('vendorApp.remote.editOwn')}
          </Button>
        ) : undefined
      }
    >
      <LoadView
        data={definitions.data}
        reload={definitions.reload}
        failed={t('vendorApp.remote.loadFailed')}
      >
        {({ definitions: list }) => (
          <LoadView data={pc.data} reload={pc.reload} failed={t('vendorApp.remote.loadFailed')}>
            {(view) => (
              <>
                <p>
                  {view.appliedDigest === view.digest ? (
                    <Badge tone="success">{t('vendorApp.remote.applied')}</Badge>
                  ) : (
                    <Badge tone="warning">{t('vendorApp.remote.waiting')}</Badge>
                  )}
                </p>
                <Table
                  caption={t('vendorApp.remote.title')}
                  hideCaption
                  rows={list}
                  rowKey={(definition) => definition.key}
                  columns={[
                    {
                      key: 'key',
                      header: t('vendorApp.remote.setting'),
                      cell: (definition) => <code className="cp-code">{definition.key}</code>,
                    },
                    {
                      key: 'fleet',
                      header: t('vendorApp.remote.fleetValue'),
                      cell: (definition) => shownValue(definition, view.fleet[definition.key], t),
                    },
                    {
                      key: 'own',
                      header: t('vendorApp.remote.ownValue'),
                      cell: (definition) =>
                        view.overrides[definition.key] === undefined
                          ? '—'
                          : shownValue(definition, view.overrides[definition.key], t),
                    },
                  ]}
                />
                {editing ? (
                  <RemoteSettingsEditor
                    title={t('vendorApp.remote.editOwnTitle')}
                    intro={t('vendorApp.remote.editOwnIntro')}
                    definitions={list}
                    values={view.overrides}
                    onClose={() => {
                      setEditing(false);
                    }}
                    onSave={async (values, reason) => {
                      await api.setInstallationRemoteSettings({
                        params: { id: installationId },
                        body: { values, reason },
                      });
                      setEditing(false);
                      toast.show({ title: t('vendorApp.remote.saved'), tone: 'success' });
                      pc.reload();
                    }}
                  />
                ) : null}
              </>
            )}
          </LoadView>
        )}
      </LoadView>
    </Card>
  );
}
