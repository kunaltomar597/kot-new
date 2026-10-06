import type { SettingKey } from '@rp/contracts';
import { EmptyState, ErrorState, LoadingState, TextField, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { useSecondFactor } from '../../owner/second-factor.js';
import { SettingDialog } from './SettingDialog.js';
import { SettingRow } from './SettingRow.js';
import { printerNamesOf, settingHint, settingLabel, settingSections } from './settings-view.js';

/**
 * The General settings page (P4-03a, MGR-007): every setting of the catalogue (P1-01a) in its
 * group, with its value in its unit and, when changed, its default, and a Change button for the
 * settings the person may change. Settings the vendor sets are shown and never changed here
 * (UPD-010); the Owner's tax, invoice and data settings say so to managers and ask the Owner for
 * the second factor (AUTH-006). A search and "changed only" narrow the list. The page follows
 * changes made on any screen (`SettingsChanged`) and printer changes (`RestaurantChanged`).
 */
export function SettingsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
    async () => {
      const [settings, printers] = await Promise.all([
        controller.api.listSettings(),
        controller.api.listPrinters(),
      ]);
      return { settings: settings.settings, printers: printers.printers };
    },
    (type) => type === 'SettingsChanged' || type === 'RestaurantChanged',
  );
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [editing, setEditing] = useState<SettingKey | undefined>();

  let content: ReactNode;
  let dialog: ReactNode = null;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('settings.general.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { settings, printers } = data.value;
    const printerNames = printerNamesOf(t, printers);
    const sections = settingSections(
      settings,
      { query, changedOnly },
      (key) => `${settingLabel(t, key)} ${settingHint(t, key)}`,
    );
    content =
      sections.length === 0 ? (
        <EmptyState
          title={
            query.trim() === ''
              ? t('settings.general.noneChanged')
              : t('settings.general.noMatch', { query: query.trim() })
          }
        />
      ) : (
        sections.map((section) => (
          <section
            key={section.group}
            className="settings-group"
            aria-labelledby={`settings-group-${section.group}`}
          >
            <h3 id={`settings-group-${section.group}`} className="settings-group__heading">
              {t(`settings.groups.${section.group}`)}
            </h3>
            <ul className="staff-list">
              {section.settings.map((setting) => (
                <SettingRow
                  key={setting.key}
                  setting={setting}
                  printerNames={printerNames}
                  onChange={() => {
                    setEditing(setting.key);
                  }}
                />
              ))}
            </ul>
          </section>
        ))
      );
    const open = settings.find((setting) => setting.key === editing);
    if (open !== undefined && editing !== undefined) {
      dialog = (
        <SettingDialog
          key={editing}
          setting={{ ...open, key: editing }}
          printers={printers}
          printerNames={printerNames}
          withSecondFactor={withSecondFactor}
          onSaved={() => {
            toast.show({
              title: t('settings.dialog.saved', { name: settingLabel(t, editing) }),
              tone: 'success',
            });
            setEditing(undefined);
            reload();
          }}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-settings">
      <h2 id="dashboard-settings" className="dashboard-section__heading">
        {t('settings.title')}
      </h2>
      <p className="dashboard-section__hint">{t('settings.general.intro')}</p>
      <div className="menu-filter">
        <TextField
          type="search"
          label={t('settings.general.search')}
          hint={t('settings.general.searchHint')}
          value={query}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <label className="console-check">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(event) => {
              setChangedOnly(event.target.checked);
            }}
          />
          {t('settings.general.changedOnly')}
        </label>
      </div>
      {content}
      {dialog}
      {secondFactorDialog}
    </section>
  );
}
