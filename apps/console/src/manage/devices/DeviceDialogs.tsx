import type {
  DeviceView,
  FloorResponse,
  PairingCodeResponse,
  StaffView,
  StationView,
} from '@rp/contracts';
import { Button, ConfirmDialog, Dialog, QrCode, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useNow } from '../../app/use-now.js';
import {
  checkPairing,
  countdown,
  holderChoices,
  PAIRABLE_TYPES,
  type PairableType,
  type PairingField,
  type PairingForm,
  pairingRequestOf,
  secondsLeft,
  stationChoices,
  suggestedDeviceName,
  tableChoices,
} from './devices-view.js';

/**
 * Pairing a device (AUTH-007, MGR-006): the manager says what it is, what it is for and what it is
 * called; the server answers with a one-time code, shown as a QR code with the code itself, the
 * server's addresses and the CA fingerprint a phone checks when its address was typed (P2-01d).
 */
export function PairDeviceDialog({
  devices,
  floor,
  stations,
  people,
  onClose,
}: {
  devices: readonly DeviceView[];
  floor: FloorResponse;
  stations: readonly StationView[];
  people: readonly StaffView[];
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const nameFor = (type: PairableType) =>
    suggestedDeviceName(devices, (number) => t(`devices.defaultName.${type}`, { number }));
  const [form, setForm] = useState<PairingForm>(() => ({
    type: 'TABLE_TABLET',
    name: nameFor('TABLE_TABLET'),
    tableId: '',
    stationId: '',
    staffId: '',
  }));
  // The suggested name follows the type until the manager types their own.
  const [nameEdited, setNameEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<PairingCodeResponse | undefined>();
  const problems = checkPairing(form);
  const problemOf = (field: PairingField) => {
    const problem = problems[field];
    return submitted && problem !== undefined ? t(`devices.pairForm.${problem}`) : undefined;
  };

  const create = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setError(undefined);
    setBusy(true);
    try {
      setCode(await controller.api.createPairingCode({ body: pairingRequestOf(form) }));
    } catch (failure) {
      setError(messageOf(failure, t));
    } finally {
      setBusy(false);
    }
  };

  if (code !== undefined) {
    return (
      <PairingCodeDialog
        name={form.name.trim()}
        code={code}
        busy={busy}
        error={error}
        onNewCode={() => {
          void create();
        }}
        onDone={onClose}
      />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('devices.pairForm.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('devices.pairForm.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('devices.pairForm.create')}
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
          void create();
        }}
      >
        <Select
          label={t('devices.pairForm.type')}
          value={form.type}
          data-autofocus
          options={PAIRABLE_TYPES.map((type) => ({
            value: type,
            label: t(`devices.typeOne.${type}`),
          }))}
          onChange={(event) => {
            const type = event.target.value as PairableType;
            setForm((current) => ({
              ...current,
              type,
              ...(!nameEdited && { name: nameFor(type) }),
            }));
          }}
        />
        <TextField
          label={t('devices.pairForm.name')}
          hint={t('devices.pairForm.nameHint')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          error={problemOf('name')}
          onChange={(event) => {
            setNameEdited(true);
            setForm((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {form.type === 'TABLE_TABLET' ? (
          <Select
            label={t('devices.pairForm.table')}
            hint={t('devices.pairForm.tableHint')}
            value={form.tableId}
            required
            error={problemOf('tableId')}
            options={[
              { value: '', label: t('devices.pairForm.chooseTable') },
              ...tableChoices(floor),
            ]}
            onChange={(event) => {
              setForm((current) => ({ ...current, tableId: event.target.value }));
            }}
          />
        ) : null}
        {form.type === 'KDS' ? (
          <Select
            label={t('devices.pairForm.station')}
            hint={t('devices.pairForm.stationHint')}
            value={form.stationId}
            options={[{ value: '', label: t('devices.allStations') }, ...stationChoices(stations)]}
            onChange={(event) => {
              setForm((current) => ({ ...current, stationId: event.target.value }));
            }}
          />
        ) : null}
        {form.type === 'WAITER_PHONE' ? (
          <Select
            label={t('devices.pairForm.person')}
            hint={t('devices.pairForm.personHint')}
            value={form.staffId}
            options={[{ value: '', label: t('devices.whoeverSignsIn') }, ...holderChoices(people)]}
            onChange={(event) => {
              setForm((current) => ({ ...current, staffId: event.target.value }));
            }}
          />
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

/** The one-time code with a countdown; an expired code can be replaced in one press. */
function PairingCodeDialog({
  name,
  code,
  busy,
  error,
  onNewCode,
  onDone,
}: {
  name: string;
  code: PairingCodeResponse;
  busy: boolean;
  error: string | undefined;
  onNewCode: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const now = useNow(1000);
  const left = secondsLeft(code.expiresAt, now);
  return (
    <Dialog
      open
      onClose={onDone}
      title={t('devices.codeDialog.title', { name })}
      footer={
        <>
          {left === 0 ? (
            <Button variant="secondary" loading={busy} onClick={onNewCode}>
              {t('devices.codeDialog.newCode')}
            </Button>
          ) : null}
          <Button onClick={onDone} data-autofocus>
            {t('devices.codeDialog.done')}
          </Button>
        </>
      }
    >
      <p className="dashboard-section__hint">{t('devices.codeDialog.steps')}</p>
      {left === 0 ? (
        <p role="status" className="console-notice console-notice--warning">
          {t('devices.codeDialog.expired')}
        </p>
      ) : (
        <div className="device-pairing">
          <QrCode
            value={code.qrPayload}
            label={t('devices.codeDialog.qrLabel', { name })}
            size={208}
          />
          <dl className="pager-credential">
            <dt>{t('devices.codeDialog.code')}</dt>
            <dd>
              <span className="pager-credential__value device-pairing__code">{code.code}</span>
              <span className="device-pairing__expiry" role="timer" aria-live="off">
                {t('devices.codeDialog.validFor', { time: countdown(left) })}
              </span>
            </dd>
            {code.serverUrls.length === 0 ? null : (
              <>
                <dt>{t('devices.codeDialog.addresses')}</dt>
                <dd>
                  <ul className="device-pairing__urls">
                    {code.serverUrls.map((url) => (
                      <li key={url} className="pager-credential__value">
                        {url}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {code.caSha256 === null ? null : (
              <>
                <dt>{t('devices.codeDialog.fingerprint')}</dt>
                <dd>
                  <span className="device-pairing__fingerprint">{code.caSha256}</span>
                  <span className="device-pairing__hint">
                    {t('devices.codeDialog.fingerprintHint')}
                  </span>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function RenameDeviceDialog({
  device,
  busy,
  error,
  onRename,
  onClose,
}: {
  device: DeviceView;
  busy: boolean;
  error: string | undefined;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [name, setName] = useState(device.name);
  const [submitted, setSubmitted] = useState(false);
  const blank = name.trim() === '';
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('devices.renameDialog.title', { name: device.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('devices.renameDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('devices.renameDialog.save')}
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
          if (!blank) onRename(name.trim());
        }}
      >
        <TextField
          label={t('devices.renameDialog.name')}
          value={name}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={submitted && blank ? t('devices.pairForm.nameRequired') : undefined}
          onChange={(event) => {
            setName(event.target.value);
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

export function MoveTabletDialog({
  device,
  floor,
  busy,
  error,
  onMove,
  onClose,
}: {
  device: DeviceView;
  floor: FloorResponse;
  busy: boolean;
  error: string | undefined;
  onMove: (tableId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const choices = tableChoices(floor).filter((choice) => choice.value !== device.tableId);
  const [tableId, setTableId] = useState(choices[0]?.value ?? '');
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('devices.moveDialog.title', { name: device.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('devices.moveDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={tableId === ''}>
            {t('devices.moveDialog.move')}
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
          if (tableId !== '') onMove(tableId);
        }}
      >
        <p className="dashboard-section__hint">{t('devices.moveDialog.description')}</p>
        <Select
          label={t('devices.moveDialog.table')}
          value={tableId}
          data-autofocus
          options={choices}
          onChange={(event) => {
            setTableId(event.target.value);
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

/** Unpairing is destructive and audited, so it asks for a reason (AUTH-008, AUD-001). */
export function UnpairDeviceDialog({
  device,
  busy,
  error,
  onUnpair,
  onClose,
}: {
  device: DeviceView;
  busy: boolean;
  error: string | undefined;
  onUnpair: (reason: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const short = reason.trim().length < 3;
  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('devices.unpairDialog.title', { name: device.name })}
      description={t('devices.unpairDialog.description')}
      confirmLabel={t('devices.unpairDialog.confirm')}
      cancelLabel={t('devices.unpairDialog.cancel')}
      busy={busy}
      onConfirm={() => {
        setSubmitted(true);
        if (!short) onUnpair(reason.trim());
      }}
      onCancel={onClose}
    >
      <TextField
        label={t('devices.unpairDialog.reason')}
        hint={t('devices.unpairDialog.reasonHint')}
        value={reason}
        maxLength={200}
        autoComplete="off"
        required
        data-autofocus
        error={submitted && short ? t('devices.unpairDialog.reasonRequired') : undefined}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
