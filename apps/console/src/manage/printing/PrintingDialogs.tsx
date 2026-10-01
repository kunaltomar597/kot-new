import type { PrinterRequest, PrinterView, StationRequest, StationView } from '@rp/contracts';
import { Button, ChoiceGroup, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { ReasonDialog } from '../menu/ReasonDialog.js';
import {
  checkPrinterDraft,
  checkStationDraft,
  type Connection,
  PAPER_WIDTHS,
  type PrinterDraft,
  type PrinterProblem,
  printerDraftOf,
  printerRequestOf,
  STATION_MODES,
  type StationDraft,
  stationDraftOf,
  stationRequestOf,
} from './printing-view.js';

interface DialogState {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onClose: () => void;
}

function ErrorNotice({ error }: { error: string | undefined }) {
  return error === undefined ? null : (
    <p role="alert" className="console-notice console-notice--danger">
      {error}
    </p>
  );
}

/** Adds a printer, or changes one (KDS-008): network with address and port, or USB by share name. */
export function PrinterDialog({
  printer,
  busy,
  error,
  onSave,
  onClose,
}: DialogState & {
  printer: PrinterView | undefined;
  onSave: (request: PrinterRequest) => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<PrinterDraft>(() => printerDraftOf(printer));
  const [submitted, setSubmitted] = useState(false);
  const problems = checkPrinterDraft(draft);
  const problemText = (problem: PrinterProblem) => {
    if (!submitted || !problems.includes(problem)) return undefined;
    return problem === 'HOST_INVALID' && draft.connection === 'USB'
      ? t('printing.problems.HOST_INVALID_USB')
      : t(`printing.problems.${problem}`);
  };
  const change = (changes: Partial<PrinterDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  const network = draft.connection === 'NETWORK';
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        printer === undefined
          ? t('printing.printerDialog.addTitle')
          : t('printing.printerDialog.editTitle', { name: printer.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('printing.printerDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('printing.printerDialog.save')}
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
          const request = printerRequestOf(draft);
          if (request !== undefined) onSave(request);
        }}
      >
        <TextField
          label={t('printing.printerDialog.name')}
          hint={t('printing.printerDialog.nameHint')}
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
        <ChoiceGroup
          legend={t('printing.printerDialog.connection')}
          mode="single"
          options={(['NETWORK', 'USB'] as const).map((connection) => ({
            id: connection,
            label: t(`printing.printers.connection.${connection}`),
          }))}
          value={[draft.connection]}
          onChange={(chosen) => {
            const connection = chosen[0] as Connection | undefined;
            if (connection !== undefined) change({ connection });
          }}
        />
        <TextField
          label={network ? t('printing.printerDialog.host') : t('printing.printerDialog.share')}
          hint={
            network ? t('printing.printerDialog.hostHint') : t('printing.printerDialog.shareHint')
          }
          value={draft.host}
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
          required
          error={problemText('HOST_INVALID')}
          onChange={(event) => {
            change({ host: event.target.value });
          }}
        />
        {network ? (
          <TextField
            label={t('printing.printerDialog.port')}
            hint={t('printing.printerDialog.portHint')}
            value={draft.port}
            inputMode="numeric"
            maxLength={5}
            autoComplete="off"
            required
            error={problemText('PORT_INVALID')}
            onChange={(event) => {
              change({ port: event.target.value });
            }}
          />
        ) : null}
        <Select
          label={t('printing.printerDialog.paper')}
          value={draft.paperWidthMm}
          options={PAPER_WIDTHS.map((width) => ({
            value: width,
            label: t('printing.printerDialog.paperWidth', { width }),
          }))}
          onChange={(event) => {
            change({ paperWidthMm: event.target.value as PrinterDraft['paperWidthMm'] });
          }}
        />
        <ErrorNotice error={error} />
      </form>
    </Dialog>
  );
}

/** Adds a station, or changes one (KDS-002, KDS-008): its tickets on screen, printed, or both. */
export function StationDialog({
  station,
  printers,
  busy,
  error,
  onSave,
  onClose,
}: DialogState & {
  station: StationView | undefined;
  /** The active printers, by name. */
  printers: readonly PrinterView[];
  onSave: (request: StationRequest) => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<StationDraft>(() => stationDraftOf(station));
  const [submitted, setSubmitted] = useState(false);
  const problems = checkStationDraft(draft);
  const problemText = (problem: (typeof problems)[number]) =>
    submitted && problems.includes(problem) ? t(`printing.problems.${problem}`) : undefined;
  // A printer archived since keeps its place, so the form never changes it silently.
  const options = printers.map((printer) => ({ value: printer.id, label: printer.name }));
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        station === undefined
          ? t('printing.stationDialog.addTitle')
          : t('printing.stationDialog.editTitle', { name: station.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('printing.stationDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('printing.stationDialog.save')}
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
          const request = stationRequestOf(draft);
          if (request !== undefined) onSave(request);
        }}
      >
        <TextField
          label={t('printing.stationDialog.name')}
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
        <ChoiceGroup
          legend={t('printing.stationDialog.mode')}
          mode="single"
          options={STATION_MODES.map((mode) => ({
            id: mode,
            label: t(`printing.stations.mode.${mode}`),
          }))}
          value={[draft.mode]}
          onChange={(chosen) => {
            const mode = STATION_MODES.find((entry) => entry === chosen[0]);
            if (mode !== undefined) setDraft((current) => ({ ...current, mode }));
          }}
        />
        <Select
          label={t('printing.stationDialog.printer')}
          hint={t('printing.stationDialog.printerHint')}
          placeholder={t('printing.stationDialog.choosePrinter')}
          value={draft.printerId}
          options={options}
          error={problemText('PRINTER_REQUIRED')}
          onChange={(event) => {
            setDraft((current) => ({ ...current, printerId: event.target.value }));
          }}
        />
        <ErrorNotice error={error} />
      </form>
    </Dialog>
  );
}

/** Sends a broken printer's tickets to another one until a manager stops it (KDS-008). */
export function RedirectDialog({
  printer,
  targets,
  busy,
  error,
  onRedirect,
  onClose,
}: DialogState & {
  printer: PrinterView;
  targets: readonly PrinterView[];
  onRedirect: (toPrinterId: string, reason: string) => void;
}) {
  const t = useT();
  const [target, setTarget] = useState('');
  const [tried, setTried] = useState(false);
  return (
    <ReasonDialog
      title={t('printing.redirectDialog.title', { name: printer.name })}
      description={t('printing.redirectDialog.description')}
      confirmLabel={t('printing.redirectDialog.confirm')}
      tone="primary"
      hint={t('printing.reasonHint')}
      busy={busy}
      error={error}
      onConfirm={(reason) => {
        setTried(true);
        if (target !== '') onRedirect(target, reason);
      }}
      onCancel={onClose}
    >
      {targets.length === 0 ? (
        <p className="console-notice">{t('printing.redirectDialog.none')}</p>
      ) : (
        <Select
          label={t('printing.redirectDialog.target')}
          placeholder={t('printing.redirectDialog.choose')}
          value={target}
          options={targets.map((other) => ({ value: other.id, label: other.name }))}
          error={tried && target === '' ? t('printing.redirectDialog.required') : undefined}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        />
      )}
    </ReasonDialog>
  );
}
