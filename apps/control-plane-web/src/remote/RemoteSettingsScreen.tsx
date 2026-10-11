import { Button, Table, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { useApi, useMay } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';
import { RemoteSettingsEditor, shownValue } from './RemoteSettingsEditor.js';

/**
 * Vendor settings and feature flags for every PC (UPD-010): what each is now, and the Super
 * Admin's changes, which reach each PC with its next heartbeat and are audited on both sides.
 */
export function RemoteSettingsScreen() {
  const t = useT();
  const api = useApi();
  const may = useMay();
  const toast = useToast();
  const { data, reload } = useLoad((signal) => api.getFleetRemoteSettings({ signal }), 'remote');
  const [editing, setEditing] = useState(false);

  return (
    <Page
      title={t('vendorApp.remote.title')}
      intro={t('vendorApp.remote.intro')}
      actions={
        may('REMOTE_CONFIG') && data.status === 'ready' ? (
          <Button
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('vendorApp.remote.edit')}
          </Button>
        ) : undefined
      }
    >
      <LoadView data={data} reload={reload} failed={t('vendorApp.remote.loadFailed')}>
        {(view) => (
          <>
            {view.updatedAt === null ? null : (
              <p className="cp-hint">
                {t('vendorApp.remote.updated', { at: when(view.updatedAt) })}
              </p>
            )}
            <Table
              caption={t('vendorApp.remote.title')}
              hideCaption
              rows={view.definitions}
              rowKey={(definition) => definition.key}
              columns={[
                {
                  key: 'key',
                  header: t('vendorApp.remote.setting'),
                  cell: (definition) => (
                    <>
                      <code className="cp-code">{definition.key}</code>
                      <br />
                      <span className="cp-hint">{definition.description}</span>
                    </>
                  ),
                },
                {
                  key: 'default',
                  header: t('vendorApp.remote.defaultValue'),
                  cell: (definition) => shownValue(definition, definition.defaultValue, t),
                },
                {
                  key: 'fleet',
                  header: t('vendorApp.remote.fleetValue'),
                  cell: (definition) => shownValue(definition, view.fleet[definition.key], t),
                },
              ]}
            />
            {editing ? (
              <RemoteSettingsEditor
                title={t('vendorApp.remote.editTitle')}
                intro={t('vendorApp.remote.editIntro')}
                definitions={view.definitions}
                values={view.fleet}
                onClose={() => {
                  setEditing(false);
                }}
                onSave={async (values, reason) => {
                  await api.setFleetRemoteSettings({ body: { values, reason } });
                  setEditing(false);
                  toast.show({ title: t('vendorApp.remote.saved'), tone: 'success' });
                  reload();
                }}
              />
            ) : null}
          </>
        )}
      </LoadView>
    </Page>
  );
}
