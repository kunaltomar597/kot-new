import type {
  InvoiceSeriesRequest,
  InvoiceSeriesView,
  RestaurantProfile,
  TaxGroupRequest,
  TaxGroupView,
  UpdateRestaurantLegalRequest,
  UpdateRestaurantProfileRequest,
} from '@rp/contracts';
import { GST_STATE_CODES, normaliseGstin } from '@rp/domain';
import { Button, Dialog, IconButton, Icon, Select, TextField } from '@rp/ui-web';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { PhotoPicker } from '../PhotoPicker.js';
import { bpText } from '../settings/settings-view.js';
import {
  badHours,
  checkLegalDraft,
  checkProfileDraft,
  checkSeriesDraft,
  checkTaxGroupDraft,
  type Day,
  draftTotalBp,
  hoursKey,
  type LegalDraft,
  type LegalProblem,
  legalDraftOf,
  legalRequestOf,
  MAX_COMPONENTS,
  type ProfileDraft,
  type ProfileProblem,
  profileDraftOf,
  profileRequestOf,
  type SeriesDraft,
  type SeriesProblem,
  seriesDraftOf,
  seriesExample,
  seriesRequestOf,
  type TaxGroupDraft,
  type TaxProblem,
  taxGroupDraftOf,
  taxGroupRequestOf,
  WEEKDAYS,
  WINDOWS_PER_DAY,
} from './restaurant-view.js';

export interface DialogState {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onClose: () => void;
}

/** The dialog frame every form here shares: title, Cancel and Save, the reason and the error. */
function FormDialog({
  title,
  busy,
  error,
  onClose,
  onSubmit,
  reason,
  onReason,
  locked = false,
  children,
}: DialogState & {
  title: string;
  onSubmit: () => void;
  reason: string;
  onReason: (reason: string) => void;
  /** A photo is uploading: saving waits. */
  locked?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const formId = useId();
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy && !locked}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('restaurantPage.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={locked}>
            {t('restaurantPage.save')}
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
          onSubmit();
        }}
      >
        {children}
        <TextField
          label={t('restaurantPage.reason')}
          hint={t('restaurantPage.reasonHint')}
          value={reason}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => {
            onReason(event.target.value);
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

/** The profile a manager keeps up to date (ONB-004 step 1): name, contact, hours, logo, cut-off. */
export function ProfileDialog({
  profile,
  onSave,
  ...state
}: DialogState & {
  profile: RestaurantProfile;
  onSave: (request: UpdateRestaurantProfileRequest) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftOf(profile));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | undefined>();
  const problems = checkProfileDraft(draft);
  const bad = submitted ? badHours(draft) : new Set<string>();
  const problemText = (problem: ProfileProblem) =>
    submitted && problems.includes(problem) ? t(`restaurantPage.problems.${problem}`) : undefined;
  const change = (changes: Partial<ProfileDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  const setWindow = (key: string, changes: { start?: string; end?: string }) => {
    setDraft((current) => ({
      ...current,
      hours: current.hours.map((window) =>
        window.key === key ? { ...window, ...changes } : window,
      ),
    }));
  };
  const addWindow = (day: Day) => {
    setDraft((current) => ({
      ...current,
      hours: [...current.hours, { key: hoursKey(), day, start: '', end: '' }],
    }));
  };
  const removeWindow = (key: string) => {
    setDraft((current) => ({
      ...current,
      hours: current.hours.filter((window) => window.key !== key),
    }));
  };
  return (
    <FormDialog
      {...state}
      error={photoError ?? state.error}
      title={t('restaurantPage.profile.dialogTitle')}
      reason={reason}
      onReason={setReason}
      locked={uploading}
      onSubmit={() => {
        setSubmitted(true);
        const request = profileRequestOf(draft, reason);
        if (request !== undefined) onSave(request);
      }}
    >
      <TextField
        label={t('restaurantPage.profile.displayName')}
        value={draft.displayName}
        maxLength={60}
        autoComplete="off"
        required
        data-autofocus
        error={problemText('NAME_REQUIRED')}
        onChange={(event) => {
          change({ displayName: event.target.value });
        }}
      />
      <div className="menu-form__row">
        <TextField
          label={t('restaurantPage.profile.phone')}
          type="tel"
          value={draft.phone}
          maxLength={20}
          autoComplete="off"
          error={problemText('PHONE_INVALID')}
          onChange={(event) => {
            change({ phone: event.target.value });
          }}
        />
        <TextField
          label={t('restaurantPage.profile.email')}
          type="email"
          value={draft.email}
          maxLength={254}
          autoComplete="off"
          error={problemText('EMAIL_INVALID')}
          onChange={(event) => {
            change({ email: event.target.value });
          }}
        />
      </div>
      <fieldset className="menu-form__section">
        <legend>{t('restaurantPage.profile.hours')}</legend>
        <p className="menu-form__hint">{t('restaurantPage.profile.hoursHint')}</p>
        {WEEKDAYS.map((day) => {
          const dayName = t(`restaurantPage.weekday.${day}`);
          const windows = draft.hours.filter((window) => window.day === day);
          return (
            <div key={day} className="restaurant-hours">
              <span className="restaurant-hours__day">{dayName}</span>
              {windows.length === 0 ? (
                <span className="restaurant-hours__closed">
                  {t('restaurantPage.profile.closed')}
                </span>
              ) : null}
              {windows.map((window, index) => (
                <div key={window.key} className="menu-form__row">
                  <TextField
                    label={t('restaurantPage.profile.opens')}
                    type="time"
                    value={window.start}
                    onChange={(event) => {
                      setWindow(window.key, { start: event.target.value });
                    }}
                  />
                  <TextField
                    label={t('restaurantPage.profile.closes')}
                    type="time"
                    value={window.end}
                    error={
                      bad.has(window.key) ? t('restaurantPage.problems.HOURS_INVALID') : undefined
                    }
                    onChange={(event) => {
                      setWindow(window.key, { end: event.target.value });
                    }}
                  />
                  <IconButton
                    label={t('restaurantPage.profile.removeHours', {
                      day: dayName,
                      number: index + 1,
                    })}
                    icon={<Icon name="close" />}
                    variant="ghost"
                    onClick={() => {
                      removeWindow(window.key);
                    }}
                  />
                </div>
              ))}
              {windows.length < WINDOWS_PER_DAY ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    addWindow(day);
                  }}
                >
                  {t('restaurantPage.profile.addHours', { day: dayName })}
                </Button>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <TextField
        label={t('restaurantPage.profile.cutoff')}
        hint={t('restaurantPage.profile.cutoffHint')}
        type="time"
        value={draft.cutoff}
        error={problemText('CUTOFF_INVALID')}
        onChange={(event) => {
          change({ cutoff: event.target.value });
        }}
      />
      <TextField
        label={t('restaurantPage.profile.accent')}
        hint={t('restaurantPage.profile.accentHint')}
        value={draft.accent}
        maxLength={7}
        error={problemText('ACCENT_INVALID')}
        onChange={(event) => {
          change({ accent: event.target.value });
        }}
      />
      <PhotoPicker
        photoId={draft.logoPhotoId}
        onChange={(logoPhotoId) => {
          change({ logoPhotoId });
        }}
        onUploading={setUploading}
        onError={setPhotoError}
        label={t('restaurantPage.profile.logo')}
        hint={t('restaurantPage.profile.logoHint')}
        alt={t('restaurantPage.profile.logoAlt')}
        uploadLabel={t('restaurantPage.profile.uploadLogo')}
        replaceLabel={t('restaurantPage.profile.replaceLogo')}
        removeLabel={t('restaurantPage.profile.removeLogo')}
        tooLarge={t('restaurantPage.profile.logoTooLarge')}
      />
    </FormDialog>
  );
}

const STATE_OPTIONS = Object.entries(GST_STATE_CODES)
  .map(([code, name]) => ({ value: code, label: `${name} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en-IN'));

/** The particulars on every tax invoice (BILL-002), for the Owner. */
export function LegalDialog({
  profile,
  onSave,
  ...state
}: DialogState & {
  profile: RestaurantProfile;
  onSave: (request: UpdateRestaurantLegalRequest) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<LegalDraft>(() => legalDraftOf(profile));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problems = checkLegalDraft(draft);
  const problemText = (...kinds: LegalProblem[]) => {
    const problem = problems.find((entry) => kinds.includes(entry));
    return submitted && problem !== undefined ? t(`restaurantPage.problems.${problem}`) : undefined;
  };
  const field = (
    name: keyof LegalDraft,
    label: string,
    problem: string | undefined,
    extra: { hint?: string; maxLength: number; inputMode?: 'numeric' },
  ) => (
    <TextField
      label={label}
      value={draft[name]}
      autoComplete="off"
      error={problem}
      {...extra}
      onChange={(event) => {
        setDraft((current) => ({ ...current, [name]: event.target.value }));
      }}
    />
  );
  return (
    <FormDialog
      {...state}
      title={t('restaurantPage.legal.dialogTitle')}
      reason={reason}
      onReason={setReason}
      onSubmit={() => {
        setSubmitted(true);
        const request = legalRequestOf(draft, reason);
        if (request !== undefined) onSave(request);
      }}
    >
      {field('legalName', t('restaurantPage.legal.legalName'), problemText('LEGAL_NAME_REQUIRED'), {
        maxLength: 120,
      })}
      {field('line1', t('restaurantPage.legal.line1'), problemText('LINE1_REQUIRED'), {
        maxLength: 120,
      })}
      {field('line2', t('restaurantPage.legal.line2'), undefined, { maxLength: 120 })}
      <div className="menu-form__row">
        {field('city', t('restaurantPage.legal.city'), problemText('CITY_REQUIRED'), {
          maxLength: 60,
        })}
        {field('pincode', t('restaurantPage.legal.pincode'), problemText('PINCODE_INVALID'), {
          maxLength: 6,
          inputMode: 'numeric',
        })}
      </div>
      <Select
        label={t('restaurantPage.legal.state')}
        placeholder={t('restaurantPage.legal.chooseState')}
        value={draft.stateCode}
        options={STATE_OPTIONS}
        error={problemText('STATE_REQUIRED')}
        onChange={(event) => {
          setDraft((current) => ({ ...current, stateCode: event.target.value }));
        }}
      />
      <TextField
        label={t('restaurantPage.legal.gstin')}
        hint={t('restaurantPage.legal.gstinHint')}
        value={draft.gstin}
        maxLength={20}
        autoComplete="off"
        spellCheck={false}
        error={problemText(
          'GSTIN_FORMAT',
          'GSTIN_STATE_CODE',
          'GSTIN_CHECKSUM',
          'GSTIN_OTHER_STATE',
        )}
        onChange={(event) => {
          setDraft((current) => ({ ...current, gstin: event.target.value }));
        }}
        onBlur={() => {
          setDraft((current) => ({ ...current, gstin: normaliseGstin(current.gstin) }));
        }}
      />
      {field('fssai', t('restaurantPage.legal.fssai'), problemText('FSSAI_INVALID'), {
        hint: t('restaurantPage.legal.fssaiHint'),
        maxLength: 14,
        inputMode: 'numeric',
      })}
    </FormDialog>
  );
}

/** A tax group with its taxes (BILL-004): rates are typed as a percent and stored in basis points. */
export function TaxGroupDialog({
  group,
  onSave,
  ...state
}: DialogState & {
  group: TaxGroupView | undefined;
  onSave: (request: TaxGroupRequest) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<TaxGroupDraft>(() => taxGroupDraftOf(group));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problems = checkTaxGroupDraft(draft);
  const problemText = (...kinds: TaxProblem[]) => {
    const problem = problems.find((entry) => kinds.includes(entry));
    return submitted && problem !== undefined ? t(`restaurantPage.problems.${problem}`) : undefined;
  };
  const total = draftTotalBp(draft);
  const setComponent = (key: string, changes: { code?: string; rate?: string }) => {
    setDraft((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.key === key ? { ...component, ...changes } : component,
      ),
    }));
  };
  return (
    <FormDialog
      {...state}
      title={
        group === undefined
          ? t('restaurantPage.taxGroups.addTitle')
          : t('restaurantPage.taxGroups.editTitle', { name: group.name })
      }
      reason={reason}
      onReason={setReason}
      onSubmit={() => {
        setSubmitted(true);
        const request = taxGroupRequestOf(draft, reason);
        if (request !== undefined) onSave(request);
      }}
    >
      <TextField
        label={t('restaurantPage.taxGroups.name')}
        hint={t('restaurantPage.taxGroups.nameHint')}
        value={draft.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={problemText('NAME_REQUIRED')}
        onChange={(event) => {
          setDraft((current) => ({ ...current, name: event.target.value }));
        }}
      />
      <TextField
        label={t('restaurantPage.taxGroups.sacCode')}
        hint={t('restaurantPage.taxGroups.sacHint')}
        value={draft.sacCode}
        maxLength={8}
        inputMode="numeric"
        autoComplete="off"
        error={problemText('SAC_INVALID')}
        onChange={(event) => {
          setDraft((current) => ({ ...current, sacCode: event.target.value }));
        }}
      />
      <fieldset className="menu-form__section">
        <legend>{t('restaurantPage.taxGroups.components')}</legend>
        {draft.components.map((component) => (
          <div key={component.key} className="menu-form__row">
            <TextField
              label={t('restaurantPage.taxGroups.code')}
              hint={t('restaurantPage.taxGroups.codeHint')}
              value={component.code}
              maxLength={10}
              autoComplete="off"
              onChange={(event) => {
                setComponent(component.key, { code: event.target.value.toUpperCase() });
              }}
            />
            <TextField
              label={t('restaurantPage.taxGroups.rate')}
              value={component.rate}
              inputMode="decimal"
              maxLength={6}
              autoComplete="off"
              onChange={(event) => {
                setComponent(component.key, { rate: event.target.value });
              }}
            />
            <IconButton
              label={t('restaurantPage.taxGroups.removeComponent', {
                code: component.code === '' ? '…' : component.code,
              })}
              icon={<Icon name="close" />}
              variant="ghost"
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  components: current.components.filter((entry) => entry.key !== component.key),
                }));
              }}
            />
          </div>
        ))}
        {draft.components.length < MAX_COMPONENTS ? (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft((current) => ({
                ...current,
                components: [...current.components, { key: hoursKey(), code: '', rate: '' }],
              }));
            }}
          >
            {t('restaurantPage.taxGroups.addComponent')}
          </Button>
        ) : null}
        {total === undefined ? null : (
          <p className="menu-form__hint">
            {t('restaurantPage.taxGroups.draftTotal', { rate: bpText(total) })}
          </p>
        )}
        {problemText('CODE_INVALID', 'CODE_DUPLICATE', 'RATE_INVALID', 'TOTAL_TOO_HIGH') ===
        undefined ? null : (
          <p className="menu-form__error">
            {problemText('CODE_INVALID', 'CODE_DUPLICATE', 'RATE_INVALID', 'TOTAL_TOO_HIGH')}
          </p>
        )}
      </fieldset>
    </FormDialog>
  );
}

/** An invoice series (BILL-003): its format is fixed once invoices carry its numbers. */
export function SeriesDialog({
  series,
  today,
  onSave,
  ...state
}: DialogState & {
  series: InvoiceSeriesView | undefined;
  /** The business date, for the example number's financial year. */
  today: string;
  onSave: (request: InvoiceSeriesRequest) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<SeriesDraft>(() => seriesDraftOf(series));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const fixed = series !== undefined && series.invoiceCount > 0;
  const problems = checkSeriesDraft(draft);
  const problemText = (...kinds: SeriesProblem[]) => {
    const problem = problems.find((entry) => kinds.includes(entry));
    return submitted && problem !== undefined ? t(`restaurantPage.problems.${problem}`) : undefined;
  };
  const example = seriesExample(draft, today);
  const change = (changes: Partial<SeriesDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  return (
    <FormDialog
      {...state}
      title={
        series === undefined
          ? t('restaurantPage.series.addTitle')
          : t('restaurantPage.series.editTitle', { name: series.name })
      }
      reason={reason}
      onReason={setReason}
      onSubmit={() => {
        setSubmitted(true);
        const request = seriesRequestOf(draft, reason);
        if (request !== undefined) onSave(request);
      }}
    >
      <TextField
        label={t('restaurantPage.series.name')}
        hint={t('restaurantPage.series.nameHint')}
        value={draft.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={problemText('NAME_REQUIRED')}
        onChange={(event) => {
          change({ name: event.target.value });
        }}
      />
      {fixed ? <p className="console-notice">{t('restaurantPage.series.fixedHint')}</p> : null}
      <TextField
        label={t('restaurantPage.series.prefix')}
        hint={t('restaurantPage.series.prefixHint')}
        value={draft.prefix}
        maxLength={10}
        autoComplete="off"
        disabled={fixed}
        error={problemText('PREFIX_INVALID', 'TOO_LONG')}
        onChange={(event) => {
          change({ prefix: event.target.value.toUpperCase() });
        }}
      />
      <label className="menu-toolbar__check">
        <input
          type="checkbox"
          checked={draft.includeFinancialYear}
          disabled={fixed}
          onChange={(event) => {
            change({ includeFinancialYear: event.target.checked });
          }}
        />
        {t('restaurantPage.series.includeFinancialYear')}
      </label>
      <div className="menu-form__row">
        <Select
          label={t('restaurantPage.series.separator')}
          value={draft.separator}
          disabled={fixed}
          options={(['/', '-'] as const).map((separator) => ({
            value: separator,
            label: separator,
          }))}
          onChange={(event) => {
            change({ separator: event.target.value === '-' ? '-' : '/' });
          }}
        />
        <TextField
          label={t('restaurantPage.series.padding')}
          hint={t('restaurantPage.series.paddingHint')}
          value={draft.sequencePadding}
          inputMode="numeric"
          maxLength={2}
          autoComplete="off"
          disabled={fixed}
          error={problemText('PADDING_INVALID')}
          onChange={(event) => {
            change({ sequencePadding: event.target.value });
          }}
        />
      </div>
      {example === undefined ? null : (
        <p className="menu-form__hint">{t('restaurantPage.series.preview', { example })}</p>
      )}
    </FormDialog>
  );
}
