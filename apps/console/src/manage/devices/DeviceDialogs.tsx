import type {
  CreatePairingCodeRequest,
  DeviceView,
  FloorResponse,
  PairingCodeResponse,
  StaffView,
  StationView,
} from '@rp/contracts';
import { timeOfDayOf } from '@rp/domain';
import { Button, Dialog, QrCode, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useNow } from '../../app/use-now.js';
import {
  checkPairing,
  holderChoices,
  nameProblem,
  newlyPaired,
  PAIRABLE_TYPES,
  type PairableType,
  type PairField,
  type PairForm,
  pairingRequestOf,
  stationChoices,
  suggestedName,
  type TableChoice,
  tableChoices,
} from './devices-view.js';

/** How often the pairing dialog checks whether its code has expired. */
const CODE_CLOCK_MS = 1_000;

/** Devices that pair by scanning the QR code in their app; the others open the console. */
const SCANS_QR: ReadonlySet<string> = new Set<PairableType>(['WAITER_PHONE', 'TABLE_TABLET']);

interface IssuedCode {
  readonly request: CreatePairingCodeRequest;
  readonly code: PairingCodeResponse;
  /** Devices paired before the code was issued: the new one is the one not among them. */
  readonly knownIds: ReadonlySet<string>;
}

/**
 * Pairs a device (AUTH-007, AUTH-009, MGR-006). First what the device is for: its type, its name,
 * and a tablet's table, a kitchen screen's station or a waiter phone's holder. Then the one-time
 * code with its QR code (for the phone and tablet apps), the server's addresses and the CA
 * fingerprint that phones typing an address compare (P2-01d), until the device has paired or the
 * code expires.
 */
export function PairDeviceDialog({
  devices,
  floor,
  stations,
  people,
  onClose,
}: {
  devices: readonly DeviceView[];
  floor: FloorResponse | undefined;
  stations: readonly StationView[];
  people: readonly StaffView[];
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const tables = tableChoices(floor);
  const tableLabel = (tableId: string) => tables.find((table) => table.id === tableId)?.label;

  /** A name for the device until someone types their own. */
  const suggestionFor = (form: Pick<PairForm, 'type' | 'tableId'>): string => {
    const table = form.type === 'TABLE_TABLET' ? tableLabel(form.tableId) : undefined;
    if (table !== undefined) return t('devices.pairDialog.tabletName', { table });
    return suggestedName(devices, (number) =>
      t(`devices.pairDialog.defaultName.${form.type}`, { number }),
    );
  };

  const [form, setForm] = useState<PairForm>(() => ({
    type: 'POS',
    name: suggestionFor({ type: 'POS', tableId: '' }),
    tableId: '',
    stationId: '',
    staffId: '',
  }));
  const [nameTyped, setNameTyped] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedCode | undefined>();
  const problems = checkPairing(form);
  const problemOf = (field: PairField) => {
    const problem = problems[field];
    return submitted && problem !== undefined ? t(`devices.pairDialog.${problem}`) : undefined;
  };

  /** Changes the type or table, and with them the suggested name if nobody typed one. */
  const choose = (changes: Partial<Pick<PairForm, 'type' | 'tableId'>>) => {
    setForm((current) => {
      const next = { ...current, ...changes };
      return nameTyped ? next : { ...next, name: suggestionFor(next) };
    });
  };

  const issue = async (request: CreatePairingCodeRequest) => {
    setError(undefined);
    setBusy(true);
    try {
      const code = await controller.api.createPairingCode({ body: request });
      setIssued({ request, code, knownIds: new Set(devices.map((device) => device.id)) });
    } catch (failure) {
      setError(messageOf(failure, t));
    } finally {
      setBusy(false);
    }
  };

  if (issued !== undefined) {
    return (
      <PairingCodeView
        issued={issued}
        devices={devices}
        busy={busy}
        error={error}
        onNewCode={() => {
          void issue(issued.request);
        }}
        onClose={onClose}
      />
    );
  }

  const noTables = form.type === 'TABLE_TABLET' && tables.length === 0;
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('devices.pairDialog.title')}
      description={t('devices.pairDialog.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('devices.pairDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={noTables}>
            {t('devices.pairDialog.create')}
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
          if (Object.keys(problems).length > 0) return;
          void issue(pairingRequestOf(form));
        }}
      >
        <Select
          label={t('devices.pairDialog.type')}
          value={form.type}
          data-autofocus
          options={PAIRABLE_TYPES.map((type) => ({
            value: type,
            label: t(`devices.type.${type}`),
          }))}
          onChange={(event) => {
            const type = PAIRABLE_TYPES.find((candidate) => candidate === event.target.value);
            if (type !== undefined) choose({ type });
          }}
        />
        {form.type === 'TABLE_TABLET' ? (
          <Select
            label={t('devices.pairDialog.table')}
            placeholder={t('devices.pairDialog.chooseTable')}
            hint={noTables ? undefined : t('devices.pairDialog.tableHint')}
            value={form.tableId}
            required
            error={noTables ? t('devices.pairDialog.noTables') : problemOf('tableId')}
            options={tables.map((table) => ({
              value: table.id,
              label: t('devices.pairDialog.tableIn', {
                table: table.label,
                section: table.section,
              }),
            }))}
            onChange={(event) => {
              choose({ tableId: event.target.value });
            }}
          />
        ) : null}
        {form.type === 'KDS' ? (
          <Select
            label={t('devices.pairDialog.station')}
            hint={t('devices.pairDialog.stationHint')}
            value={form.stationId}
            options={[
              { value: '', label: t('devices.pairDialog.allStations') },
              ...stationChoices(stations).map((station) => ({
                value: station.id,
                label: station.name,
              })),
            ]}
            onChange={(event) => {
              setForm((current) => ({ ...current, stationId: event.target.value }));
            }}
          />
        ) : null}
        {form.type === 'WAITER_PHONE' ? (
          <Select
            label={t('devices.pairDialog.holder')}
            hint={t('devices.pairDialog.holderHint')}
            value={form.staffId}
            options={[
              { value: '', label: t('devices.pairDialog.nobody') },
              ...holderChoices(people).map((person) => ({
                value: person.id,
                label: person.displayName,
              })),
            ]}
            onChange={(event) => {
              setForm((current) => ({ ...current, staffId: event.target.value }));
            }}
          />
        ) : null}
        <TextField
          label={t('devices.pairDialog.name')}
          hint={t('devices.pairDialog.nameHint')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          error={problemOf('name')}
          onChange={(event) => {
            setNameTyped(true);
            setForm((current) => ({ ...current, name: event.target.value }));
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

/** The issued code, until the device pairs with it (shown as soon as the list has it) or it expires. */
function PairingCodeView({
  issued,
  devices,
  busy,
  error,
  onNewCode,
  onClose,
}: {
  issued: IssuedCode;
  devices: readonly DeviceView[];
  busy: boolean;
  error: string | undefined;
  onNewCode: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const now = useNow(CODE_CLOCK_MS);
  const { request, code } = issued;
  const paired = newlyPaired(issued.knownIds, devices, request);
  const expired = paired === undefined && Date.parse(code.expiresAt) <= now;
  const scansQr = SCANS_QR.has(request.type);

  let state: string;
  if (paired !== undefined) state = t('devices.pairDialog.paired', { name: paired.name });
  else if (expired) state = t('devices.pairDialog.expired');
  else state = t('devices.pairDialog.waiting');

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('devices.pairDialog.codeTitle', { name: request.name })}
      description={scansQr ? t('devices.pairDialog.scanApp') : t('devices.pairDialog.openConsole')}
      footer={
        paired !== undefined ? (
          <Button data-autofocus onClick={onClose}>
            {t('devices.pairDialog.done')}
          </Button>
        ) : expired ? (
          <Button data-autofocus loading={busy} onClick={onNewCode}>
            {t('devices.pairDialog.newCode')}
          </Button>
        ) : undefined
      }
    >
      <div className="pairing-code">
        {scansQr && !expired && paired === undefined ? (
          <QrCode
            value={code.qrPayload}
            label={t('devices.pairDialog.qrLabel', { name: request.name })}
            size={208}
          />
        ) : null}
        <dl className="pager-credential">
          <dt>{t('devices.pairDialog.code')}</dt>
          <dd>
            <code className="pager-credential__value">{code.code}</code>
          </dd>
          {code.serverUrls.length === 0 ? null : (
            <>
              <dt>{t('devices.pairDialog.addresses')}</dt>
              <dd className="pairing-code__addresses">
                {code.serverUrls.map((url) => (
                  <code key={url} className="pairing-code__address">
                    {url}
                  </code>
                ))}
              </dd>
            </>
          )}
          {code.caSha256 === null ? null : (
            <>
              <dt>{t('devices.pairDialog.fingerprint')}</dt>
              <dd>
                <code className="pairing-code__fingerprint">{code.caSha256}</code>
                <p className="pairing-code__hint">{t('devices.pairDialog.fingerprintHint')}</p>
              </dd>
            </>
          )}
        </dl>
        {expired || paired !== undefined ? null : (
          <p className="pairing-code__hint">
            {t('devices.pairDialog.validUntil', {
              time: timeOfDayOf(new Date(code.expiresAt)),
            })}
          </p>
        )}
        <p
          role="status"
          className="pairing-code__state"
          data-state={paired !== undefined ? 'paired' : expired ? 'expired' : 'waiting'}
        >
          {state}
        </p>
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Renames a device (MGR-006), e.g. after it moved to another counter. */
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
  const problem = nameProblem(name);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={t('devices.renameDialog.title', { name: device.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('devices.renameDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('devices.renameDialog.confirm')}
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
          if (problem === undefined) onRename(name.trim());
        }}
      >
        <TextField
          label={t('devices.renameDialog.name')}
          value={name}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={submitted && problem !== undefined ? t(`devices.renameDialog.${problem}`) : error}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
}

/**
 * Moves a table tablet to another table (AUTH-009, TAB-002): a manager does it, and the tablet
 * then serves only the new table.
 */
export function MoveTabletDialog({
  device,
  floor,
  busy,
  error,
  onMove,
  onClose,
}: {
  device: DeviceView;
  floor: FloorResponse | undefined;
  busy: boolean;
  error: string | undefined;
  onMove: (table: TableChoice) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const tables = tableChoices(floor, device.tableId);
  const [tableId, setTableId] = useState('');
  const chosen = tables.find((table) => table.id === tableId);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={t('devices.moveDialog.title', { name: device.name })}
      description={t('devices.moveDialog.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('devices.moveDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={chosen === undefined}>
            {t('devices.moveDialog.confirm')}
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
          if (chosen !== undefined) onMove(chosen);
        }}
      >
        <Select
          label={t('devices.moveDialog.table')}
          placeholder={t('devices.moveDialog.choose')}
          value={tableId}
          required
          data-autofocus
          options={tables.map((table) => ({
            value: table.id,
            label: t('devices.pairDialog.tableIn', { table: table.label, section: table.section }),
          }))}
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
