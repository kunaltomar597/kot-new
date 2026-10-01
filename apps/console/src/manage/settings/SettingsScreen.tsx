import type { NotificationEventType, PrinterView, SettingKey, SettingView } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Select,
  TextArea,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import {
  bpText,
  checkedValue,
  type Draft,
  draftOf,
  type Editor,
  editorOf,
  groupSettings,
  needsOwner,
} from './settings-view.js';

type Translate = ReturnType<typeof useT>;
/** A settings area: the first part of a key, e.g. `kds`. */
type Area = SettingKey extends `${infer Prefix}.${string}` ? Prefix : never;

const CHOICES = new Set([
  'TAX_EXCLUSIVE',
  'TAX_INCLUSIVE',
  'CONTINUOUS',
  'HOURLY',
  '12h',
  '24h',
  'ONE_LONG',
  'TWO_SHORT',
  'THREE_SHORT',
  'THREE',
  'ONE_SHORT',
  'LONG_SHORT',
] as const);
type ChoiceKey = typeof CHOICES extends Set<infer K> ? K : never;

const FIELDS = new Set([
  'READY',
  'SERVICE_REQUEST',
  'MANAGER',
  'BREAKFAST',
  'LUNCH',
  'EVENING',
  'DINNER',
] as const);
type FieldKey = typeof FIELDS extends Set<infer K> ? K : never;

const UNITS = {
  minutes: 'minutes',
  seconds: 'seconds',
  hours: 'hours',
  days: 'days',
  months: 'months',
  percent: 'percent',
  GB: 'GB',
  characters: 'characters',
  orders: 'orders',
} as const;

function choiceLabel(value: string | number, t: Translate): string {
  return CHOICES.has(value as ChoiceKey)
    ? t(`settingsPage.choice.${value as ChoiceKey}`)
    : String(value);
}

function fieldLabel(name: string, t: Translate): string {
  return FIELDS.has(name as FieldKey) ? t(`settingsPage.field.${name as FieldKey}`) : name;
}

function eventLabel(name: string, t: Translate): string {
  return t(`alerts.type.${name as NotificationEventType}`);
}

/** A stored value in words, the way the setting reads it (NFR-L03). */
function describe(
  editor: Editor | undefined,
  value: unknown,
  unit: string | undefined,
  printers: readonly PrinterView[],
  t: Translate,
): string {
  if (editor === undefined) return JSON.stringify(value);
  switch (editor.kind) {
    case 'BOOLEAN':
      return value === true ? t('settingsPage.on') : t('settingsPage.off');
    case 'NUMBER': {
      const number = typeof value === 'number' ? value : 0;
      if (editor.scale === 'BP') return t('settingsPage.unit.bp', { value: bpText(number) });
      if (editor.scale === 'PAISE') return formatRupees(number);
      const key = unit === undefined ? undefined : UNITS[unit as keyof typeof UNITS];
      return key === undefined
        ? t('settingsPage.unit.plain', { value: number })
        : t(`settingsPage.unit.${key}`, { value: number });
    }
    case 'CHOICE':
      return choiceLabel(value as string | number, t);
    case 'LIST':
      return Array.isArray(value) && value.length > 0
        ? value.map(String).join(' · ')
        : t('settingsPage.empty');
    case 'TEXT':
      return typeof value === 'string' && value !== '' ? value : t('settingsPage.none');
    case 'PRINTER':
      return printers.find((printer) => printer.id === value)?.name ?? t('settingsPage.none');
    case 'WINDOW': {
      const window = value as { start: string; end: string };
      return t('settingsPage.windowValue', { start: window.start, end: window.end });
    }
    case 'FIELDS': {
      const object = (value ?? {}) as Record<string, unknown>;
      return editor.fields
        .map(
          (field) =>
            `${fieldLabel(field.name, t)}: ${describe(field.editor, object[field.name], undefined, printers, t)}`,
        )
        .join(' · ');
    }
    case 'RECORD': {
      const entries = Object.entries((value ?? {}) as Record<string, string>);
      return entries.length === 0
        ? t('settingsPage.none')
        : entries
            .map(([key, chosen]) => `${eventLabel(key, t)}: ${choiceLabel(chosen, t)}`)
            .join(' · ');
    }
    case 'RULES': {
      const count = Object.keys(value ?? {}).length;
      return count === 0 ? t('settingsPage.none') : t('settingsPage.unit.plain', { value: count });
    }
  }
}

/**
 * The Settings page (P4-03a, MGR-007, UPD-010): every setting of the catalogue by area, with its
 * value, its default when changed, and who may change it. Settings the vendor controls are shown
 * but not changed here; tax, invoice, data and licence settings ask for the Owner's second factor
 * (AUTH-006). The editor for each comes from its schema, and every change says why.
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
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<
    { readonly setting: SettingView; readonly editor: Editor } | undefined
  >();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setEditing(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  const label = (key: string) => t(`settingLabels.${key as SettingKey}`);
  const hint = (key: string) => t(`settingHints.${key as SettingKey}`);

  const save = async (setting: SettingView, value: unknown, reason: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await withSecondFactor(() =>
        controller.api.updateSetting({
          params: { key: setting.key },
          body: { value, ...(reason.trim() !== '' && { reason: reason.trim() }) },
        }),
      );
      toast.show({ title: t('settingsPage.saved', { name: label(setting.key) }), tone: 'success' });
      close();
      reload();
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('settingsPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const groups = groupSettings(
      data.value.settings,
      search,
      (setting) => `${label(setting.key)} ${hint(setting.key)}`,
    );
    content =
      groups.length === 0 ? (
        <EmptyState title={t('menuEditor.items.noMatch')} />
      ) : (
        groups.map((group) => (
          <section
            key={group.area}
            className="device-group"
            aria-labelledby={`settings-${group.area}`}
          >
            <h3 id={`settings-${group.area}`} className="device-group__heading">
              {t(`settingsPage.area.${group.area as Area}`)}
            </h3>
            <ul className="staff-list" aria-labelledby={`settings-${group.area}`}>
              {group.settings.map((setting) => {
                const editor = editorOf(setting.key);
                const name = label(setting.key);
                return (
                  <li key={setting.key} className="staff-row">
                    <div className="staff-row__who">
                      <h4 className="staff-row__name">{name}</h4>
                      <p className="staff-row__contact">{hint(setting.key)}</p>
                      <p className="settings-row__value">
                        {describe(editor, setting.value, setting.unit, data.value.printers, t)}
                      </p>
                      <p className="staff-row__states">
                        {setting.isDefault ? null : (
                          <Badge tone="info">{t('settingsPage.changed')}</Badge>
                        )}
                        {setting.scope === 'VENDOR' ? (
                          <Badge tone="neutral" icon={<Icon name="ban" />}>
                            {t('settingsPage.vendor')}
                          </Badge>
                        ) : null}
                        {needsOwner(setting) ? (
                          <Badge tone="warning">{t('settingsPage.ownerOnly')}</Badge>
                        ) : null}
                      </p>
                      {setting.isDefault ? null : (
                        <p className="staff-row__contact">
                          {t('settingsPage.default', {
                            value: describe(
                              editor,
                              setting.defaultValue,
                              setting.unit,
                              data.value.printers,
                              t,
                            ),
                          })}
                        </p>
                      )}
                      {setting.scope === 'RESTAURANT' && !setting.editable ? (
                        <p className="staff-row__contact">{t('settingsPage.notYours')}</p>
                      ) : null}
                    </div>
                    {setting.editable && editor !== undefined && editor.kind !== 'RULES' ? (
                      <div
                        className="staff-row__actions"
                        role="group"
                        aria-label={t('settingsPage.actionsFor', { name })}
                      >
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setEditing({ setting, editor });
                          }}
                        >
                          {t('settingsPage.edit')}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-settings">
      <h2 id="dashboard-settings" className="dashboard-section__heading">
        {t('settingsPage.title')}
      </h2>
      <p className="dashboard-section__hint">{t('settingsPage.intro')}</p>
      <div className="menu-toolbar">
        <TextField
          label={t('settingsPage.search')}
          type="search"
          value={search}
          autoComplete="off"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      {content}
      {editing !== undefined && data.status === 'ready' ? (
        <SettingDialog
          setting={editing.setting}
          editor={editing.editor}
          name={label(editing.setting.key)}
          printers={data.value.printers}
          busy={busy}
          error={error}
          onSave={(value, reason) => {
            void save(editing.setting, value, reason);
          }}
          onClose={close}
        />
      ) : null}
      {secondFactorDialog}
    </section>
  );
}

/** One setting's editor, its default in one press, and an optional reason for the audit trail. */
function SettingDialog({
  setting,
  editor,
  name,
  printers,
  busy,
  error,
  onSave,
  onClose,
}: {
  setting: SettingView;
  editor: Editor;
  name: string;
  printers: readonly PrinterView[];
  busy: boolean;
  error: string | undefined;
  onSave: (value: unknown, reason: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(editor, setting.value));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const checked = checkedValue(setting.key, editor, draft);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('settingsPage.dialog.title', { name })}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy || setting.isDefault}
            onClick={() => {
              setDraft(draftOf(editor, setting.defaultValue));
            }}
          >
            {t('settingsPage.dialog.useDefault')}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('settingsPage.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('settingsPage.dialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (checked.ok) onSave(checked.value, reason);
        }}
      >
        <p className="dashboard-section__hint">{t(`settingHints.${setting.key as SettingKey}`)}</p>
        <DraftField
          editor={editor}
          draft={draft}
          label={name}
          printers={printers}
          error={submitted && !checked.ok ? t('settingsPage.dialog.invalid') : undefined}
          onChange={setDraft}
          autoFocus
        />
        <TextField
          label={t('settingsPage.dialog.reason')}
          hint={t('settingsPage.dialog.reasonHint')}
          value={reason}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The inputs for one editor; nested editors (a field of an object) render the same way. */
function DraftField({
  editor,
  draft,
  label,
  printers,
  error,
  onChange,
  autoFocus = false,
}: {
  editor: Editor;
  draft: Draft;
  label: string;
  printers: readonly PrinterView[];
  error: string | undefined;
  onChange: (draft: Draft) => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  const focus = autoFocus ? { 'data-autofocus': true } : {};
  switch (editor.kind) {
    case 'BOOLEAN':
      return (
        <>
          <label className="menu-toolbar__check">
            <input
              type="checkbox"
              checked={draft === true}
              {...focus}
              onChange={(event) => {
                onChange(event.target.checked);
              }}
            />
            {label}
          </label>
          {error === undefined ? null : <p className="menu-form__error">{error}</p>}
        </>
      );
    case 'NUMBER': {
      const range =
        editor.scale === 'BP'
          ? { min: `${bpText(editor.min)}%`, max: `${bpText(editor.max)}%` }
          : editor.scale === 'PAISE'
            ? { min: formatRupees(editor.min), max: formatRupees(editor.max) }
            : { min: String(editor.min), max: String(editor.max) };
      return (
        <TextField
          label={label}
          hint={t('settingsPage.dialog.range', range)}
          value={draft as string}
          inputMode="decimal"
          autoComplete="off"
          error={error}
          {...focus}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    }
    case 'CHOICE':
      return (
        <Select
          label={label}
          value={draft as string}
          error={error}
          {...focus}
          options={editor.options.map((option) => ({
            value: String(option),
            label: choiceLabel(option, t),
          }))}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'LIST':
      return (
        <TextArea
          label={label}
          hint={t('settingsPage.dialog.listHint')}
          value={draft as string}
          error={error}
          {...focus}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'TEXT':
      return (
        <TextField
          label={label}
          value={draft as string}
          autoComplete="off"
          error={error}
          {...focus}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'PRINTER':
      return (
        <Select
          label={label}
          value={draft as string}
          error={error}
          {...focus}
          options={[
            { value: '', label: t('settingsPage.none') },
            ...printers
              .filter((printer) => printer.archivedAt === null)
              .map((printer) => ({ value: printer.id, label: printer.name })),
          ]}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'WINDOW': {
      const window = draft as { start: string; end: string };
      return (
        <fieldset className="menu-form__section">
          <legend>{label}</legend>
          <div className="menu-form__row">
            <TextField
              label={t('settingsPage.dialog.start')}
              type="time"
              value={window.start}
              {...focus}
              onChange={(event) => {
                onChange({ ...window, start: event.target.value });
              }}
            />
            <TextField
              label={t('settingsPage.dialog.end')}
              type="time"
              value={window.end}
              error={error}
              onChange={(event) => {
                onChange({ ...window, end: event.target.value });
              }}
            />
          </div>
        </fieldset>
      );
    }
    case 'FIELDS': {
      const object = draft as Record<string, Draft>;
      return (
        <fieldset className="menu-form__section">
          <legend>{label}</legend>
          {editor.fields.map((field, index) => (
            <DraftField
              key={field.name}
              editor={field.editor}
              draft={object[field.name] ?? ''}
              label={fieldLabel(field.name, t)}
              printers={printers}
              error={index === editor.fields.length - 1 ? error : undefined}
              autoFocus={autoFocus && index === 0}
              onChange={(next) => {
                onChange({ ...object, [field.name]: next });
              }}
            />
          ))}
        </fieldset>
      );
    }
    case 'RECORD': {
      const object = draft as Record<string, string>;
      return (
        <fieldset className="menu-form__section">
          <legend>{label}</legend>
          {editor.keys.map((key, index) => (
            <Select
              key={key}
              label={eventLabel(key, t)}
              value={object[key] ?? ''}
              {...(index === 0 ? focus : {})}
              options={[
                { value: '', label: t('settingsPage.none') },
                ...editor.options.map((option) => ({
                  value: option,
                  label: choiceLabel(option, t),
                })),
              ]}
              onChange={(event) => {
                onChange({ ...object, [key]: event.target.value });
              }}
            />
          ))}
          {error === undefined ? null : <p className="menu-form__error">{error}</p>}
        </fieldset>
      );
    }
    case 'RULES':
      return null;
  }
}
