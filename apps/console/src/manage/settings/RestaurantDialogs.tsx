import type { RestaurantProfile, Weekday } from '@rp/contracts';
import { Button, Icon, TextField } from '@rp/ui-web';
import { useRef, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { photoBase64 } from '../menu/menu-view.js';
import { FormDialog, ReasonField } from './FormDialog.js';
import {
  businessHoursOf,
  checkContact,
  checkCutoff,
  type ContactField,
  type ContactForm,
  contactChangeOf,
  contactFormOf,
  copyHours,
  type HoursForm,
  type HoursWindow,
  hoursAreValid,
  hoursFormOf,
  isOvernight,
  type ProfileChange,
  profileRequestOf,
  reasonProblemOf,
  WEEKDAYS,
  WINDOWS_PER_DAY,
  windowProblemOf,
} from './restaurant-view.js';

/** Saves one part of the profile with an optional reason; the server's refusal stays in the dialog. */
function useProfileSave(profile: RestaurantProfile, onSaved: (saved: RestaurantProfile) => void) {
  const t = useT();
  const controller = useConsole();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const save = async (change: ProfileChange) => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(
        await controller.api.updateRestaurantProfile({
          body: profileRequestOf(profile, change, reason),
        }),
      );
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };
  return { reason, setReason, busy, error, save };
}

/**
 * The name guests and staff see, the phone and email printed on bills, and the logo (ONB-004
 * step 1). Uploading a logo uses the photo store, which needs permission to manage the menu;
 * without it the logo can still be removed.
 */
export function ContactDialog({
  profile,
  uploadsLogo,
  onSaved,
  onClose,
}: {
  profile: RestaurantProfile;
  uploadsLogo: boolean;
  onSaved: (saved: RestaurantProfile) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { reason, setReason, busy, error, save } = useProfileSave(profile, onSaved);
  const [form, setForm] = useState<ContactForm>(() => contactFormOf(profile));
  const [submitted, setSubmitted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);

  const problems = checkContact(form);
  const problemOf = (field: ContactField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`restaurant.contactDialog.problems.${problem}`)
      : undefined;
  };
  const set = <K extends keyof ContactForm>(key: K, value: ContactForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const upload = async (file: File) => {
    setLogoError(undefined);
    const content = await photoBase64(file);
    if (!content.ok) {
      setLogoError(t('restaurant.contactDialog.logoTooLarge'));
      return;
    }
    setUploading(true);
    try {
      const photo = await controller.api.uploadPhoto({ body: { contentBase64: content.base64 } });
      set('logoPhotoId', photo.id);
    } catch (failure) {
      setLogoError(messageOf(failure, t));
    } finally {
      setUploading(false);
    }
  };

  return (
    <FormDialog
      title={t('restaurant.contactDialog.title')}
      busy={busy || uploading}
      error={error}
      onConfirm={() => {
        setSubmitted(true);
        if (Object.keys(problems).length > 0 || reasonProblemOf(reason) !== undefined) return;
        void save(contactChangeOf(form));
      }}
      onClose={onClose}
    >
      <TextField
        label={t('restaurant.contactDialog.name')}
        hint={t('restaurant.contactDialog.nameHint')}
        value={form.displayName}
        maxLength={60}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('displayName')}
        onChange={(event) => {
          set('displayName', event.target.value);
        }}
      />
      <TextField
        label={t('restaurant.contactDialog.phone')}
        hint={t('restaurant.contactDialog.phoneHint')}
        type="tel"
        inputMode="tel"
        value={form.phone}
        maxLength={24}
        autoComplete="off"
        error={problemOf('phone')}
        onChange={(event) => {
          set('phone', event.target.value);
        }}
      />
      <TextField
        label={t('restaurant.contactDialog.email')}
        type="email"
        value={form.email}
        maxLength={254}
        autoComplete="off"
        spellCheck={false}
        error={problemOf('email')}
        onChange={(event) => {
          set('email', event.target.value);
        }}
      />
      <fieldset className="menu-editor__section">
        <legend className="menu-editor__legend">{t('restaurant.contactDialog.logo')}</legend>
        <div className="menu-photo">
          {form.logoPhotoId === null ? (
            <p className="menu-photo__none">{t('restaurant.contact.noLogo')}</p>
          ) : (
            <img
              className="settings-logo"
              src={controller.photoSrc(form.logoPhotoId, 480)}
              alt={t('restaurant.contact.logoAlt', {
                name: form.displayName.trim() || profile.displayName,
              })}
            />
          )}
          <div className="menu-photo__actions">
            {uploadsLogo ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
                  hidden
                  aria-label={t('restaurant.contactDialog.logo')}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file !== undefined) void upload(file);
                  }}
                />
                <Button
                  variant="secondary"
                  loading={uploading}
                  onClick={() => {
                    fileRef.current?.click();
                  }}
                >
                  {form.logoPhotoId === null
                    ? t('restaurant.contactDialog.chooseLogo')
                    : t('restaurant.contactDialog.replaceLogo')}
                </Button>
              </>
            ) : null}
            {form.logoPhotoId === null ? null : (
              <Button
                variant="ghost"
                disabled={uploading}
                onClick={() => {
                  set('logoPhotoId', null);
                }}
              >
                {t('restaurant.contactDialog.removeLogo')}
              </Button>
            )}
          </div>
          <p className="rp-field__hint" aria-live="polite">
            {uploading
              ? t('restaurant.contactDialog.uploading')
              : uploadsLogo
                ? t('restaurant.contactDialog.logoHint')
                : t('restaurant.contactDialog.logoNeedsMenu')}
          </p>
          {logoError === undefined ? null : (
            <p role="alert" className="rp-field__error">
              {logoError}
            </p>
          )}
        </div>
      </fieldset>
      <ReasonField reason={reason} submitted={submitted} onChange={setReason} />
    </FormDialog>
  );
}

/**
 * The week's opening hours (ONB-004 step 1): each day closed or open in up to four windows, one
 * that ends before it starts closing after midnight. Monday's hours can be given to every day.
 */
export function HoursDialog({
  profile,
  onSaved,
  onClose,
}: {
  profile: RestaurantProfile;
  onSaved: (saved: RestaurantProfile) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { reason, setReason, busy, error, save } = useProfileSave(profile, onSaved);
  const [form, setForm] = useState<HoursForm>(() => hoursFormOf(profile.businessHours));
  const [submitted, setSubmitted] = useState(false);

  const setDay = (day: Weekday, windows: readonly HoursWindow[]) => {
    setForm((current) => ({ ...current, [day]: windows }));
  };

  return (
    <FormDialog
      title={t('restaurant.hoursDialog.title')}
      description={t('restaurant.hoursDialog.description')}
      busy={busy}
      error={error}
      onConfirm={() => {
        setSubmitted(true);
        if (!hoursAreValid(form) || reasonProblemOf(reason) !== undefined) return;
        void save({ businessHours: businessHoursOf(form) });
      }}
      onClose={onClose}
    >
      {WEEKDAYS.map((day, dayIndex) => {
        const dayName = t(`restaurant.days.${day}`);
        const windows = form[day];
        return (
          <div key={day} className="settings-day">
            <h3 className="settings-day__name">{dayName}</h3>
            {windows.length === 0 ? (
              <p className="settings-day__closed">{t('restaurant.hoursDialog.closed')}</p>
            ) : (
              windows.map((window, index) => (
                <HoursFields
                  key={index}
                  legend={t('restaurant.hoursDialog.hoursLegend', {
                    day: dayName,
                    number: index + 1,
                  })}
                  window={window}
                  autoFocus={dayIndex === 0 && index === 0}
                  submitted={submitted}
                  removeLabel={t('restaurant.hoursDialog.removeLabel', {
                    day: dayName,
                    number: index + 1,
                  })}
                  onChange={(changed) => {
                    setDay(
                      day,
                      windows.map((entry, at) => (at === index ? changed : entry)),
                    );
                  }}
                  onRemove={() => {
                    setDay(
                      day,
                      windows.filter((_, at) => at !== index),
                    );
                  }}
                />
              ))
            )}
            <div className="settings-day__actions">
              <Button
                variant="secondary"
                startIcon={<Icon name="plus" />}
                aria-label={t('restaurant.hoursDialog.addLabel', { day: dayName })}
                disabled={windows.length >= WINDOWS_PER_DAY}
                onClick={() => {
                  setDay(day, [...windows, { start: '', end: '' }]);
                }}
              >
                {t('restaurant.hoursDialog.add')}
              </Button>
              {dayIndex === 0 ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setForm((current) => copyHours(current, day));
                  }}
                >
                  {t('restaurant.hoursDialog.copy', { day: dayName })}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      <ReasonField reason={reason} submitted={submitted} onChange={setReason} />
    </FormDialog>
  );
}

/** One window of a day: when it opens and closes, and a button to remove it. */
function HoursFields({
  legend,
  window,
  autoFocus,
  submitted,
  removeLabel,
  onChange,
  onRemove,
}: {
  legend: string;
  window: HoursWindow;
  autoFocus: boolean;
  submitted: boolean;
  removeLabel: string;
  onChange: (window: HoursWindow) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const problem = submitted ? windowProblemOf(window) : undefined;
  const message =
    problem === undefined ? undefined : t(`restaurant.hoursDialog.problems.${problem}`);
  // A missing time is marked where it is missing; times that are the same, at the closing one.
  const startMissing = problem === 'time' && !/^\d{2}:\d{2}$/.test(window.start);
  return (
    <fieldset className="settings-window">
      <legend className="settings-window__legend">{legend}</legend>
      <div className="settings-window__times">
        <TextField
          label={t('restaurant.hoursDialog.opens')}
          type="time"
          data-autofocus={autoFocus || undefined}
          value={window.start}
          error={startMissing ? message : undefined}
          onChange={(event) => {
            onChange({ ...window, start: event.target.value });
          }}
        />
        <TextField
          label={t('restaurant.hoursDialog.closes')}
          type="time"
          value={window.end}
          error={problem !== undefined && !startMissing ? message : undefined}
          onChange={(event) => {
            onChange({ ...window, end: event.target.value });
          }}
        />
      </div>
      {window.end !== '' && window.start !== '' && isOvernight(window) ? (
        <p className="dashboard-section__hint">{t('restaurant.hoursDialog.overnight')}</p>
      ) : null}
      <div>
        <Button variant="ghost" aria-label={removeLabel} onClick={onRemove}>
          {t('restaurant.hoursDialog.remove')}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * When the business day ends (BRD §9.4). The server refuses a change that would move the business
 * date records are being filed under right now, and says why here.
 */
export function CutoffDialog({
  profile,
  onSaved,
  onClose,
}: {
  profile: RestaurantProfile;
  onSaved: (saved: RestaurantProfile) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { reason, setReason, busy, error, save } = useProfileSave(profile, onSaved);
  const [cutoff, setCutoff] = useState(profile.businessDayCutoff);
  const [submitted, setSubmitted] = useState(false);
  const problem = checkCutoff(cutoff);
  return (
    <FormDialog
      title={t('restaurant.cutoffDialog.title')}
      description={t('restaurant.cutoffDialog.description')}
      busy={busy}
      error={error}
      onConfirm={() => {
        setSubmitted(true);
        if (problem !== undefined || reasonProblemOf(reason) !== undefined) return;
        void save({ businessDayCutoff: cutoff });
      }}
      onClose={onClose}
    >
      <TextField
        label={t('restaurant.cutoffDialog.time')}
        hint={t('restaurant.cutoffDialog.hint')}
        type="time"
        data-autofocus
        value={cutoff}
        error={
          submitted && problem !== undefined
            ? t(`restaurant.cutoffDialog.problems.${problem}`)
            : undefined
        }
        onChange={(event) => {
          setCutoff(event.target.value);
        }}
      />
      <ReasonField reason={reason} submitted={submitted} onChange={setReason} />
    </FormDialog>
  );
}
