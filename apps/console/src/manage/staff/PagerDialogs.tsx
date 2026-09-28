import type { PagerCredentialResponse, PagerView, StaffView } from '@rp/contracts';
import { Button, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import {
  checkPager,
  createPagerRequestOf,
  type PagerField,
  type PagerForm,
  suggestedName,
  wearersFor,
} from './pagers-view.js';

/**
 * Registers a pager from the serial on its label or pairing screen (PGR-012; a barcode scanner
 * types into the field like a keyboard), optionally giving it to someone at once. The server
 * answers with the pager's credential, shown next and only once.
 */
export function RegisterPagerDialog({
  pagers,
  people,
  onRegistered,
  onClose,
}: {
  pagers: readonly PagerView[];
  people: readonly StaffView[];
  onRegistered: (name: string, credential: PagerCredentialResponse) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [form, setForm] = useState<PagerForm>(() => ({
    serial: '',
    name: suggestedName(pagers, (number) => t('pagers.form.defaultName', { number })),
    staffId: '',
  }));
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const problems = checkPager(form);
  const problemOf = (field: PagerField) => {
    const problem = problems[field];
    return submitted && problem !== undefined ? t(`pagers.form.${problem}`) : undefined;
  };

  const register = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setError(undefined);
    setBusy(true);
    try {
      const body = createPagerRequestOf(form);
      const credential = await controller.api.createPager({ body });
      onRegistered(body.name, credential);
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
      title={t('pagers.form.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('pagers.form.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('pagers.form.register')}
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
          void register();
        }}
      >
        <TextField
          label={t('pagers.form.serial')}
          hint={t('pagers.form.serialHint')}
          value={form.serial}
          maxLength={32}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          data-autofocus
          error={problemOf('serial')}
          onChange={(event) => {
            setForm((current) => ({ ...current, serial: event.target.value }));
          }}
        />
        <TextField
          label={t('pagers.form.name')}
          hint={t('pagers.form.nameHint')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          error={problemOf('name')}
          onChange={(event) => {
            setForm((current) => ({ ...current, name: event.target.value }));
          }}
        />
        <Select
          label={t('pagers.form.wearer')}
          value={form.staffId}
          options={[
            { value: '', label: t('pagers.form.nobody') },
            ...wearersFor(people).map((person) => ({
              value: person.id,
              label: person.displayName,
            })),
          ]}
          onChange={(event) => {
            setForm((current) => ({ ...current, staffId: event.target.value }));
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

/**
 * Gives a pager to someone (PGR-012, PGR-014): anyone active, managers included. A person wears
 * one pager, so the server takes back any other they wear.
 */
export function GivePagerDialog({
  pager,
  people,
  busy,
  error,
  onGive,
  onClose,
}: {
  pager: PagerView;
  people: readonly StaffView[];
  busy: boolean;
  error: string | undefined;
  onGive: (person: StaffView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const wearers = wearersFor(people, pager);
  const [staffId, setStaffId] = useState('');
  const chosen = wearers.find((person) => person.id === staffId);

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={t('pagers.giveDialog.title', { pager: pager.name })}
      description={t('pagers.giveDialog.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('pagers.giveDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={chosen === undefined}>
            {t('pagers.giveDialog.confirm')}
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
          if (chosen !== undefined) onGive(chosen);
        }}
      >
        <Select
          label={t('pagers.giveDialog.person')}
          placeholder={t('pagers.giveDialog.choose')}
          value={staffId}
          required
          data-autofocus
          options={wearers.map((person) => ({ value: person.id, label: person.displayName }))}
          onChange={(event) => {
            setStaffId(event.target.value);
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

/**
 * A pager's credential, shown once after registering it or issuing a new one (SEC-012): only
 * "I have entered it" closes the dialog, since the password cannot be shown again.
 */
export function PagerCredentialDialog({
  pagerName,
  credential,
  onDone,
}: {
  pagerName: string;
  credential: PagerCredentialResponse;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open
      onClose={onDone}
      dismissible={false}
      title={t('pagers.credentialDialog.title', { pager: pagerName })}
      description={t('pagers.credentialDialog.description')}
      footer={
        <Button data-autofocus onClick={onDone}>
          {t('pagers.credentialDialog.done')}
        </Button>
      }
    >
      <dl className="pager-credential">
        <dt>{t('pagers.credentialDialog.pagerId')}</dt>
        <dd>
          <code className="pager-credential__value">{credential.mqttUsername}</code>
        </dd>
        <dt>{t('pagers.credentialDialog.password')}</dt>
        <dd>
          <code className="pager-credential__value">{credential.mqttPassword}</code>
        </dd>
        <dt>{t('pagers.credentialDialog.port')}</dt>
        <dd>
          <code className="pager-credential__value">{String(credential.mqttPort)}</code>
        </dd>
      </dl>
    </Dialog>
  );
}
