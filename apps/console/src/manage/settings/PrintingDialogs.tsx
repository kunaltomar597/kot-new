import type { PrinterView, StationView } from '@rp/contracts';
import { ChoiceGroup, Select, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { FormDialog } from './FormDialog.js';
import {
  activePrinters,
  CONNECTIONS,
  checkPrinter,
  checkStation,
  emptyPrinterForm,
  emptyStationForm,
  PAPER_WIDTHS,
  type PrinterField,
  type PrinterForm,
  printerFormOf,
  printerRequestOf,
  redirectTargets,
  STATION_MODES,
  type StationField,
  type StationForm,
  stationFormOf,
  stationRequestOf,
} from './printing-view.js';

const isConnection = (value: string): value is PrinterForm['connection'] =>
  CONNECTIONS.some((connection) => connection === value);
const isMode = (value: string): value is StationForm['mode'] =>
  STATION_MODES.some((mode) => mode === value);

/**
 * Adds a printer or changes one (KDS-008, ONB-004 step 6): its name, how it is connected, its
 * address and port or its share name, and its paper. The server audits it.
 */
export function PrinterDialog({
  printer,
  printers,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  printer: PrinterView | undefined;
  printers: readonly PrinterView[];
  onSaved: (saved: PrinterView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const [form, setForm] = useState<PrinterForm>(() =>
    printer === undefined ? emptyPrinterForm() : printerFormOf(printer),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problems = checkPrinter(form, printers, printer?.id);
  const problemOf = (field: PrinterField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`printing.printerDialog.problems.${problem}`)
      : undefined;
  };
  const network = form.connection === 'NETWORK';

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    const body = printerRequestOf(form);
    try {
      onSaved(
        printer === undefined
          ? await controller.api.createPrinter({ body })
          : await controller.api.updatePrinter({ params: { id: printer.id }, body }),
      );
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={
        printer === undefined
          ? t('printing.printerDialog.addTitle')
          : t('printing.printerDialog.editTitle', { name: printer.name })
      }
      busy={busy}
      error={error}
      onConfirm={() => {
        void save();
      }}
      onClose={onClose}
    >
      <TextField
        label={t('printing.printerDialog.name')}
        hint={t('printing.printerDialog.nameHint')}
        value={form.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('name')}
        onChange={(event) => {
          const name = event.target.value;
          setForm((current) => ({ ...current, name }));
        }}
      />
      <ChoiceGroup
        legend={t('printing.printerDialog.connection')}
        mode="single"
        options={CONNECTIONS.map((connection) => ({
          id: connection,
          label: t(`printing.printerDialog.connectionChoice.${connection}`),
        }))}
        value={[form.connection]}
        onChange={([chosen]) => {
          if (chosen !== undefined && isConnection(chosen)) {
            setForm((current) => ({ ...current, connection: chosen }));
          }
        }}
      />
      <TextField
        label={t(network ? 'printing.printerDialog.host' : 'printing.printerDialog.share')}
        hint={t(network ? 'printing.printerDialog.hostHint' : 'printing.printerDialog.shareHint')}
        value={form.host}
        maxLength={120}
        autoComplete="off"
        spellCheck={false}
        required
        error={problemOf('host')}
        onChange={(event) => {
          const host = event.target.value;
          setForm((current) => ({ ...current, host }));
        }}
      />
      {network ? (
        <TextField
          label={t('printing.printerDialog.port')}
          hint={t('printing.printerDialog.portHint')}
          inputMode="numeric"
          autoComplete="off"
          value={form.port}
          maxLength={5}
          required
          error={problemOf('port')}
          onChange={(event) => {
            const port = event.target.value;
            setForm((current) => ({ ...current, port }));
          }}
        />
      ) : null}
      <ChoiceGroup
        legend={t('printing.printerDialog.paper')}
        mode="single"
        options={PAPER_WIDTHS.map((width) => ({
          id: String(width),
          label: t(`printing.printerDialog.paperChoice.${String(width) as '58' | '80'}`),
        }))}
        value={[String(form.paperWidthMm)]}
        onChange={([chosen]) => {
          const width = PAPER_WIDTHS.find((option) => String(option) === chosen);
          if (width !== undefined) setForm((current) => ({ ...current, paperWidthMm: width }));
        }}
      />
    </FormDialog>
  );
}

/**
 * Adds a station or changes one (KDS-008): its name, whether its tickets are shown on a kitchen
 * screen, printed or both, and the printer they print on. The server audits it.
 */
export function StationDialog({
  station,
  stations,
  printers,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  station: StationView | undefined;
  stations: readonly StationView[];
  printers: readonly PrinterView[];
  onSaved: (saved: StationView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const [form, setForm] = useState<StationForm>(() =>
    station === undefined ? emptyStationForm(printers) : stationFormOf(station),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problems = checkStation(form, stations, printers, station?.id);
  const problemOf = (field: StationField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`printing.stationDialog.problems.${problem}`)
      : undefined;
  };
  const usable = activePrinters(printers);

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    const body = stationRequestOf(form);
    try {
      onSaved(
        station === undefined
          ? await controller.api.createStation({ body })
          : await controller.api.updateStation({ params: { id: station.id }, body }),
      );
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={
        station === undefined
          ? t('printing.stationDialog.addTitle')
          : t('printing.stationDialog.editTitle', { name: station.name })
      }
      busy={busy}
      error={error}
      onConfirm={() => {
        void save();
      }}
      onClose={onClose}
    >
      <TextField
        label={t('printing.stationDialog.name')}
        hint={t('printing.stationDialog.nameHint')}
        value={form.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('name')}
        onChange={(event) => {
          const name = event.target.value;
          setForm((current) => ({ ...current, name }));
        }}
      />
      <ChoiceGroup
        legend={t('printing.stationDialog.mode')}
        mode="single"
        options={STATION_MODES.map((mode) => ({
          id: mode,
          label: t(`printing.stationDialog.modeChoice.${mode}`),
        }))}
        value={[form.mode]}
        onChange={([chosen]) => {
          if (chosen !== undefined && isMode(chosen)) {
            setForm((current) => ({ ...current, mode: chosen }));
          }
        }}
      />
      {form.mode === 'SCREEN' ? null : (
        <Select
          label={t('printing.stationDialog.printer')}
          hint={usable.length === 0 ? t('printing.stationDialog.noPrinters') : undefined}
          value={form.printerId}
          placeholder={
            form.printerId === '' ? t('printing.stationDialog.choosePrinter') : undefined
          }
          options={usable.map((printer) => ({ value: printer.id, label: printer.name }))}
          required
          error={problemOf('printerId')}
          onChange={(event) => {
            const printerId = event.target.value;
            setForm((current) => ({ ...current, printerId }));
          }}
        />
      )}
    </FormDialog>
  );
}

/**
 * Sends a printer's tickets, and those waiting for it, to another printer until changed back
 * (KDS-008: reprinted on another printer chosen by the manager). Audited with the reason.
 */
export function RedirectDialog({
  printer,
  printers,
  onSaved,
  onClose,
}: {
  printer: PrinterView;
  printers: readonly PrinterView[];
  onSaved: (to: PrinterView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const targets = redirectTargets(printer, printers);
  const [to, setTo] = useState(() => (targets.length === 1 ? (targets[0]?.id ?? '') : ''));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const target = targets.find((entry) => entry.id === to);
  const reasonOk = reason.trim().length >= 3;

  const save = async () => {
    setSubmitted(true);
    if (target === undefined || !reasonOk) return;
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.redirectPrinter({
        params: { id: printer.id },
        body: { toPrinterId: target.id, reason: reason.trim() },
      });
      onSaved(target);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={t('printing.redirectDialog.title', { name: printer.name })}
      description={t('printing.redirectDialog.description', { name: printer.name })}
      confirmLabel={t('printing.redirectDialog.confirm')}
      busy={busy}
      error={error}
      onConfirm={() => {
        void save();
      }}
      onClose={onClose}
    >
      <Select
        label={t('printing.redirectDialog.to')}
        hint={targets.length === 0 ? t('printing.redirectDialog.none') : undefined}
        value={to}
        placeholder={to === '' ? t('printing.redirectDialog.choose') : undefined}
        options={targets.map((entry) => ({ value: entry.id, label: entry.name }))}
        required
        error={
          submitted && target === undefined ? t('printing.redirectDialog.toMissing') : undefined
        }
        onChange={(event) => {
          setTo(event.target.value);
        }}
      />
      <TextField
        label={t('printing.redirectDialog.reason')}
        hint={t('printing.redirectDialog.reasonHint')}
        value={reason}
        maxLength={200}
        autoComplete="off"
        required
        error={submitted && !reasonOk ? t('printing.redirectDialog.reasonMissing') : undefined}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
    </FormDialog>
  );
}
