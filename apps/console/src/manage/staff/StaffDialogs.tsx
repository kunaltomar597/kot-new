import type { StaffView } from '@rp/contracts';
import { rolesOffered } from '@rp/domain';
import { Button, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { SecondFactorCancelled, type WithSecondFactor } from '../../owner/second-factor.js';
import {
  checkPerson,
  checkPin,
  createRequestOf,
  emptyPersonForm,
  type PersonField,
  type PersonForm,
  type PersonProblem,
  personFormOf,
  type StaffActorView,
  updateRequestOf,
} from './staff-view.js';

/** A PIN typed on a keyboard or a touch screen: digits only, never read aloud or remembered. */
function PinField({
  label,
  hint,
  value,
  error,
  pinLength,
  first = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  error: string | undefined;
  pinLength: number;
  /** The dialog's first field, focused when it opens. */
  first?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <TextField
      label={label}
      hint={hint}
      data-autofocus={first || undefined}
      type="password"
      inputMode="numeric"
      autoComplete="new-password"
      maxLength={pinLength}
      value={value}
      required
      error={error}
      onChange={(event) => {
        onChange(event.target.value.replace(/\D/g, '').slice(0, pinLength));
      }}
    />
  );
}

/**
 * Adds a person (name, role, contact, PIN) or edits one (name, role, contact), offering only the
 * roles the signed-in person may give (MGR-004). Adding, promoting or demoting a manager asks the
 * Owner for the second factor first (AUTH-006).
 */
export function PersonDialog({
  actor,
  person,
  pinLength,
  withSecondFactor,
  onSaved,
  onClose,
}: {
  actor: StaffActorView;
  /** Undefined to add someone. */
  person: StaffView | undefined;
  pinLength: number;
  withSecondFactor: WithSecondFactor;
  onSaved: (saved: StaffView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const target =
    person === undefined ? null : { staffId: person.id, role: person.role, active: person.active };
  const roles = rolesOffered(actor, target);
  const [form, setForm] = useState<PersonForm>(() =>
    person === undefined
      ? emptyPersonForm(roles.includes('WAITER') ? 'WAITER' : (roles[0] ?? 'WAITER'))
      : personFormOf(person),
  );
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const adding = person === undefined;
  const problems = checkPerson(form, { withPin: adding, pinLength });
  const problemOf = (field: PersonField): string | undefined => {
    const problem: PersonProblem | undefined = problems[field];
    return submitted && problem !== undefined
      ? t(`staff.form.${problem}`, { length: pinLength })
      : undefined;
  };
  const set = (field: PersonField) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setError(undefined);
    setBusy(true);
    try {
      let saved: StaffView;
      if (person === undefined) {
        const body = createRequestOf(form);
        saved = await withSecondFactor(() => controller.api.createStaff({ body }));
      } else {
        const body = updateRequestOf(person, form);
        if (body === undefined) {
          onClose();
          return;
        }
        const params = { staffId: person.id };
        saved = await withSecondFactor(() => controller.api.updateStaff({ params, body }));
      }
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
      title={
        adding ? t('staff.form.addTitle') : t('staff.form.editTitle', { name: person.displayName })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('staff.form.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {adding ? t('staff.form.add') : t('staff.form.save')}
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
        <TextField
          label={t('staff.form.name')}
          hint={t('staff.form.nameHint')}
          value={form.displayName}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={problemOf('displayName')}
          onChange={(event) => {
            set('displayName')(event.target.value);
          }}
        />
        {roles.length > 1 ? (
          <Select
            label={t('staff.form.role')}
            value={form.role}
            options={roles.map((role) => ({ value: role, label: t(`roles.${role}`) }))}
            onChange={(event) => {
              set('role')(event.target.value);
            }}
          />
        ) : (
          <p className="staff-form__role">
            {t('staff.form.role')}: {t(`roles.${form.role}`)}
          </p>
        )}
        <TextField
          label={t('staff.form.phone')}
          type="tel"
          autoComplete="off"
          maxLength={20}
          value={form.phone}
          error={problemOf('phone')}
          onChange={(event) => {
            set('phone')(event.target.value);
          }}
        />
        <TextField
          label={t('staff.form.email')}
          type="email"
          autoComplete="off"
          maxLength={254}
          value={form.email}
          error={problemOf('email')}
          onChange={(event) => {
            set('email')(event.target.value);
          }}
        />
        {adding ? (
          <>
            <PinField
              label={t('staff.form.pin')}
              hint={t('staff.form.pinHint', { length: pinLength })}
              value={form.pin}
              error={problemOf('pin')}
              pinLength={pinLength}
              onChange={set('pin')}
            />
            <PinField
              label={t('staff.form.pinAgain')}
              value={form.pinAgain}
              error={problemOf('pinAgain')}
              pinLength={pinLength}
              onChange={set('pinAgain')}
            />
          </>
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

/**
 * A new PIN (AUTH-001): the person's other sign-ins end and a locked login opens again. Typed
 * twice, since nobody sees it.
 */
export function PinDialog({
  person,
  self,
  pinLength,
  onSaved,
  onClose,
}: {
  person: StaffView;
  self: boolean;
  pinLength: number;
  onSaved: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const problems = checkPin(pin, pinAgain, pinLength);
  const problemOf = (field: 'pin' | 'pinAgain') => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`staff.form.${problem}`, { length: pinLength })
      : undefined;
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setError(undefined);
    setBusy(true);
    try {
      await controller.api.setStaffPin({ params: { staffId: person.id }, body: { pin } });
      onSaved();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={t('staff.pin.title', { name: person.displayName })}
      description={self ? t('staff.pin.descriptionSelf') : t('staff.pin.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('staff.form.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('staff.pin.save')}
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
        <PinField
          label={t('staff.form.pin')}
          hint={t('staff.form.pinHint', { length: pinLength })}
          value={pin}
          error={problemOf('pin')}
          pinLength={pinLength}
          first
          onChange={setPin}
        />
        <PinField
          label={t('staff.form.pinAgain')}
          value={pinAgain}
          error={problemOf('pinAgain')}
          pinLength={pinLength}
          onChange={setPinAgain}
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
