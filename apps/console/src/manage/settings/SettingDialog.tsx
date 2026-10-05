import type { PrinterView, SettingKey, SettingView } from '@rp/contracts';
import { Button, Dialog, Select, TextArea, TextField } from '@rp/ui-web';
import { type ReactNode, useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { SecondFactorCancelled, type WithSecondFactor } from '../../owner/second-factor.js';
import {
  asksSecondFactor,
  checkDraft,
  draftOf,
  fieldOf,
  formatNumber,
  formatValue,
  optionLabel,
  partLabel,
  type PrinterNames,
  sameValue,
  type SettingDraft,
  type SettingField,
  settingHint,
  settingLabel,
  type SettingProblem,
  type TimeWindowValue,
  unitOf,
  updateRequestOf,
} from './settings-view.js';

/** The unit typed beside a number, as a key under `settings.unitShort`. */
function shortUnitOf(key: SettingKey) {
  const unit = unitOf(key);
  if (unit === undefined) return undefined;
  if (unit === 'basis points') return 'percent' as const;
  if (unit === 'paise') return 'rupees' as const;
  return unit;
}

/**
 * Changes one setting (P4-03a, MGR-007) with the editor its validation calls for, checked as the
 * server checks it before anything is sent, with the default one press away and an optional
 * reason for the audit log (AUD-001). The Owner's tax, invoice and data settings ask for the
 * second factor first (AUTH-006). Saving an unchanged value just closes.
 */
export function SettingDialog({
  setting,
  printers,
  printerNames,
  withSecondFactor,
  onSaved,
  onClose,
}: {
  setting: SettingView & { readonly key: SettingKey };
  printers: readonly PrinterView[];
  printerNames: PrinterNames;
  withSecondFactor: WithSecondFactor;
  onSaved: (saved: SettingView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const { key } = setting;
  const field = fieldOf(key);
  const label = settingLabel(t, key);
  const [draft, setDraft] = useState<SettingDraft>(() => draftOf(key, setting.value));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const check = checkDraft(key, draft);
  const isDefault = check.ok && sameValue(check.value, setting.defaultValue);

  const problemText = (problem: SettingProblem): string => {
    switch (problem.kind) {
      case 'number':
        return t('settings.dialog.problems.number', {
          min: formatNumber(t, unitOf(key), problem.min),
          max: formatNumber(t, unitOf(key), problem.max),
        });
      case 'tooManyLines':
        return t('settings.dialog.problems.tooManyLines', { max: problem.max });
      case 'lineTooLong':
        return t('settings.dialog.problems.lineTooLong', { length: problem.length });
      case 'tooLong':
        return t('settings.dialog.problems.tooLong', { length: problem.length });
      default:
        return t(`settings.dialog.problems.${problem.kind}`);
    }
  };
  const problem = submitted && !check.ok ? problemText(check.problem) : undefined;

  const save = async () => {
    setSubmitted(true);
    if (!check.ok) return;
    if (sameValue(check.value, setting.value)) {
      onClose();
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const saved = await withSecondFactor(() =>
        controller.api.updateSetting({
          params: { key },
          body: updateRequestOf(check.value, reason),
        }),
      );
      onSaved(saved);
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={label}
      description={settingHint(t, key)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('settings.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('settings.dialog.save')}
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
          void save();
        }}
      >
        <SettingEditor
          settingKey={key}
          field={field}
          label={label}
          draft={draft}
          problem={problem}
          printers={printers}
          printerNames={printerNames}
          current={setting.value}
          onChange={setDraft}
        />
        <div className="settings-default">
          <p className="settings-default__text">
            {t('settings.dialog.default', {
              value: formatValue(t, key, setting.defaultValue, printerNames),
            })}
          </p>
          {isDefault ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(draftOf(key, setting.defaultValue));
              }}
            >
              {t('settings.dialog.useDefault')}
            </Button>
          )}
        </div>
        <TextField
          label={t('settings.dialog.reason')}
          hint={t('settings.dialog.reasonHint')}
          value={reason}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {asksSecondFactor(setting) ? (
          <p className="console-notice">{t('settings.dialog.secondFactor')}</p>
        ) : null}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The field for one kind of setting. */
function SettingEditor({
  settingKey: key,
  field,
  label,
  draft,
  problem,
  printers,
  printerNames,
  current,
  onChange,
}: {
  settingKey: SettingKey;
  field: SettingField;
  label: string;
  draft: SettingDraft;
  problem: string | undefined;
  printers: readonly PrinterView[];
  printerNames: PrinterNames;
  /** The saved value, so a printer archived since it was chosen can still be shown. */
  current: unknown;
  onChange: (draft: SettingDraft) => void;
}): ReactNode {
  const t = useT();
  switch (field.kind) {
    case 'number': {
      const unit = unitOf(key);
      const short = shortUnitOf(key);
      return (
        <TextField
          label={label}
          hint={t('settings.dialog.range', {
            min: formatNumber(t, unit, field.min),
            max: formatNumber(t, unit, field.max),
          })}
          data-autofocus
          inputMode={unit === 'basis points' || unit === 'paise' ? 'decimal' : 'numeric'}
          autoComplete="off"
          value={draft as string}
          endAdornment={short === undefined ? undefined : t(`settings.unitShort.${short}`)}
          error={problem}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    }
    case 'switch':
      return (
        <label className="console-check">
          <input
            type="checkbox"
            data-autofocus
            checked={draft === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          {label}
        </label>
      );
    case 'choice':
      return (
        <Select
          label={label}
          data-autofocus
          value={draft as string}
          options={field.options.map((option) => ({
            value: String(option),
            label: optionLabel(t, key, option),
          }))}
          error={problem}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'lines':
      return (
        <TextArea
          label={label}
          hint={t(field.minLines > 0 ? 'settings.dialog.linesRequired' : 'settings.dialog.lines', {
            max: field.maxLines,
            length: field.maxLength,
          })}
          data-autofocus
          rows={Math.min(Math.max(field.maxLines, 2), 6)}
          value={draft as string}
          error={problem}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'text':
      return (
        <TextField
          label={label}
          hint={t('settings.dialog.textHint', { length: field.maxLength })}
          data-autofocus
          autoComplete="off"
          maxLength={field.maxLength}
          value={draft as string}
          error={problem}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'printer': {
      const shown = printers.filter(
        (printer) => printer.archivedAt === null || printer.id === current,
      );
      return (
        <Select
          label={label}
          data-autofocus
          value={draft as string}
          options={[
            { value: '', label: t('settings.values.printerEachTime') },
            ...shown.map((printer) => ({
              value: printer.id,
              label: printerNames.get(printer.id) ?? printer.name,
            })),
          ]}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    }
    case 'window':
      return (
        <WindowFields
          legend={label}
          window={draft as TimeWindowValue}
          first
          onChange={onChange}
          problem={problem}
        />
      );
    case 'windows': {
      const windows = draft as Readonly<Record<string, TimeWindowValue>>;
      return (
        <>
          {field.parts.map((part, index) => (
            <WindowFields
              key={part}
              legend={partLabel(t, key, part)}
              window={windows[part] ?? { start: '', end: '' }}
              first={index === 0}
              onChange={(window) => {
                onChange({ ...windows, [part]: window });
              }}
            />
          ))}
          {problem === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {problem}
            </p>
          )}
        </>
      );
    }
  }
}

/** A daily window: from and to, a window ending before it starts running past midnight. */
function WindowFields({
  legend,
  window,
  first,
  problem,
  onChange,
}: {
  legend: string;
  window: TimeWindowValue;
  first: boolean;
  problem?: string | undefined;
  onChange: (window: TimeWindowValue) => void;
}) {
  const t = useT();
  return (
    <fieldset className="settings-window">
      <legend className="settings-window__legend">{legend}</legend>
      <div className="settings-window__times">
        <TextField
          label={t('settings.dialog.start')}
          type="time"
          data-autofocus={first || undefined}
          value={window.start}
          error={problem}
          onChange={(event) => {
            onChange({ ...window, start: event.target.value });
          }}
        />
        <TextField
          label={t('settings.dialog.end')}
          type="time"
          value={window.end}
          onChange={(event) => {
            onChange({ ...window, end: event.target.value });
          }}
        />
      </div>
      {window.end !== '' && window.end < window.start ? (
        <p className="dashboard-section__hint">{t('settings.dialog.overnight')}</p>
      ) : null}
    </fieldset>
  );
}
