import type { SettingKey, SettingView } from '@rp/contracts';
import { Badge, Button } from '@rp/ui-web';
import { useT } from '../../app/i18n.js';
import {
  accessOf,
  formatValue,
  type PrinterNames,
  settingHint,
  settingLabel,
} from './settings-view.js';

/** One setting: its name, value, what it does, its default when changed, and who changes it. */
export function SettingRow({
  setting,
  printerNames,
  onChange,
}: {
  setting: SettingView & { readonly key: SettingKey };
  printerNames: PrinterNames;
  onChange: () => void;
}) {
  const t = useT();
  const { key } = setting;
  const access = accessOf(setting);
  const label = settingLabel(t, key);
  return (
    <li className="staff-row">
      <div className="staff-row__who">
        <h4 className="staff-row__name">{label}</h4>
        <p className="settings-row__value">{formatValue(t, key, setting.value, printerNames)}</p>
        <p className="staff-row__contact">{settingHint(t, key)}</p>
        {setting.isDefault && access === 'EDIT' ? null : (
          <p className="staff-row__states">
            {setting.isDefault ? null : <Badge tone="info">{t('settings.row.changed')}</Badge>}
            {access === 'VENDOR' ? <Badge tone="neutral">{t('settings.row.vendor')}</Badge> : null}
            {access === 'OWNER_ONLY' ? (
              <Badge tone="neutral">{t('settings.row.ownerOnly')}</Badge>
            ) : null}
            {access === 'NOT_YOURS' ? (
              <Badge tone="neutral">{t('settings.row.notYours')}</Badge>
            ) : null}
          </p>
        )}
        {setting.isDefault ? null : (
          <p className="staff-row__contact">
            {t('settings.row.default', {
              value: formatValue(t, key, setting.defaultValue, printerNames),
            })}
          </p>
        )}
      </div>
      {access === 'EDIT' ? (
        <div className="staff-row__actions">
          <Button
            variant="secondary"
            aria-label={t('settings.row.changeLabel', { name: label })}
            onClick={onChange}
          >
            {t('settings.row.change')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
