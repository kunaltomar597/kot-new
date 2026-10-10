import type { PrinterView, StationView } from '@rp/contracts';
import type { Tone } from '@rp/design-tokens';
import { Badge, Button, EmptyState, ErrorState, Icon, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { lastSeenOf, shortDateOf } from '../devices/devices-view.js';
import { PrinterDialog, RedirectDialog, StationDialog } from './PrintingDialogs.js';
import {
  activePrinters,
  activeStations,
  DEFAULT_PORT,
  isOffline,
  type PrinterHealth,
  printerHealthOf,
  printerNameOf,
  printerOfStation,
  stationsPrintingOn,
} from './printing-view.js';

interface PrintingData {
  readonly printers: readonly PrinterView[];
  readonly stations: readonly StationView[];
}

/** Setup changes (stations, printers) and a printer stopping or printing again. */
const AFFECTS = new Set(['RestaurantChanged', 'PrinterStatusChanged']);

const HEALTH_TONES: Record<PrinterHealth['kind'], Tone> = {
  READY: 'success',
  OFFLINE: 'danger',
  UNTRIED: 'neutral',
};

type Open =
  | { readonly kind: 'ADD_PRINTER' }
  | {
      readonly kind: 'EDIT_PRINTER' | 'ARCHIVE_PRINTER' | 'REDIRECT' | 'UNREDIRECT';
      readonly printer: PrinterView;
    }
  | { readonly kind: 'ADD_STATION' }
  | { readonly kind: 'EDIT_STATION' | 'ARCHIVE_STATION'; readonly station: StationView };

type PrinterAction = 'EDIT' | 'REDIRECT' | 'UNREDIRECT' | 'ARCHIVE';

/**
 * The Stations and printers page (P4-03d, KDS-008, ONB-004 step 6): the printers with how each is
 * doing, the stations that print on it and a test page, and the stations with how they get their
 * tickets. A broken printer's tickets can be sent to another printer until it prints again. Every
 * change is audited by the server and reaches every screen at once (`RestaurantChanged`); a
 * printer stopping or printing again (`PrinterStatusChanged`) shows here too.
 */
export function PrintingScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    async (): Promise<PrintingData> => {
      const [printers, stations] = await Promise.all([
        controller.api.listPrinters(),
        controller.api.listStations(),
      ]);
      return { printers: printers.printers, stations: stations.stations };
    },
    (type) => AFFECTS.has(type),
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [testing, setTesting] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  };
  const changed = (title: string) => {
    toast.show({ title, tone: 'success' });
    close();
    reload();
  };
  /** A change asked for in a reason dialog: its refusal stays in the dialog. */
  const withReason = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      changed(done);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  /** A failed test page is an answer from the printer, not an error of the page (ONB-004). */
  const testPrint = async (printer: PrinterView) => {
    setTesting(printer.id);
    try {
      const result = await controller.api.testPrinter({ params: { id: printer.id } });
      toast.show(
        result.printed
          ? { title: t('printing.printers.testPrinted', { name: printer.name }), tone: 'success' }
          : {
              title: t('printing.printers.testFailed', {
                name: printer.name,
                error: result.error ?? '',
              }),
              tone: 'danger',
            },
      );
      reload();
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    } finally {
      setTesting(undefined);
    }
  };

  let content: ReactNode;
  let dialog: ReactNode = null;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('printing.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { printers, stations } = data.value;
    const shownPrinters = activePrinters(printers);
    const shownStations = activeStations(stations);
    const now = new Date();
    content = (
      <>
        <section className="settings-group" aria-labelledby="printing-printers">
          <div className="staff-header">
            <h3 id="printing-printers" className="settings-group__heading">
              {t('printing.printers.title')}
            </h3>
            <Button
              startIcon={<Icon name="plus" />}
              onClick={() => {
                setOpen({ kind: 'ADD_PRINTER' });
              }}
            >
              {t('printing.printers.add')}
            </Button>
          </div>
          <p className="dashboard-section__hint">{t('printing.printers.intro')}</p>
          {shownPrinters.length === 0 ? (
            <EmptyState title={t('printing.printers.none')} />
          ) : (
            <ul className="staff-list">
              {shownPrinters.map((printer) => (
                <PrinterRow
                  key={printer.id}
                  printer={printer}
                  printers={printers}
                  stations={stations}
                  now={now}
                  testing={testing === printer.id}
                  onTest={() => {
                    void testPrint(printer);
                  }}
                  onAction={(action) => {
                    setOpen({ kind: PRINTER_OPENS[action], printer });
                  }}
                />
              ))}
            </ul>
          )}
        </section>
        <section className="settings-group" aria-labelledby="printing-stations">
          <div className="staff-header">
            <h3 id="printing-stations" className="settings-group__heading">
              {t('printing.stations.title')}
            </h3>
            <Button
              variant="secondary"
              startIcon={<Icon name="plus" />}
              onClick={() => {
                setOpen({ kind: 'ADD_STATION' });
              }}
            >
              {t('printing.stations.add')}
            </Button>
          </div>
          <p className="dashboard-section__hint">{t('printing.stations.intro')}</p>
          {shownStations.length === 0 ? (
            <EmptyState title={t('printing.stations.none')} />
          ) : (
            <ul className="staff-list">
              {shownStations.map((station) => (
                <StationRow
                  key={station.id}
                  station={station}
                  printers={printers}
                  onEdit={() => {
                    setOpen({ kind: 'EDIT_STATION', station });
                  }}
                  onArchive={() => {
                    setOpen({ kind: 'ARCHIVE_STATION', station });
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      </>
    );
    if (open?.kind === 'ADD_PRINTER' || open?.kind === 'EDIT_PRINTER') {
      dialog = (
        <PrinterDialog
          printer={open.kind === 'EDIT_PRINTER' ? open.printer : undefined}
          printers={printers}
          onSaved={(saved) => {
            changed(t('printing.printerDialog.saved', { name: saved.name }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ADD_STATION' || open?.kind === 'EDIT_STATION') {
      dialog = (
        <StationDialog
          station={open.kind === 'EDIT_STATION' ? open.station : undefined}
          stations={stations}
          printers={printers}
          onSaved={(saved) => {
            changed(t('printing.stationDialog.saved', { name: saved.name }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'REDIRECT') {
      const { printer } = open;
      dialog = (
        <RedirectDialog
          printer={printer}
          printers={printers}
          onSaved={(to) => {
            changed(t('printing.printers.redirectedToast', { name: printer.name, to: to.name }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'UNREDIRECT') {
      const { printer } = open;
      dialog = (
        <ReasonDialog
          title={t('printing.unredirectDialog.title', { name: printer.name })}
          description={t('printing.unredirectDialog.description', {
            name: printer.name,
            to: printerNameOf(printers, printer.redirectToId) ?? '',
          })}
          label={t('printing.unredirectDialog.reason')}
          confirmLabel={t('printing.unredirectDialog.confirm')}
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void withReason(
              () =>
                controller.api.redirectPrinter({
                  params: { id: printer.id },
                  body: { toPrinterId: null, reason },
                }),
              t('printing.printers.unredirectedToast', { name: printer.name }),
            );
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_PRINTER') {
      const { printer } = open;
      dialog = (
        <ReasonDialog
          title={t('printing.archivePrinter.title', { name: printer.name })}
          description={t('printing.archivePrinter.description')}
          label={t('printing.archivePrinter.reason')}
          confirmLabel={t('printing.archivePrinter.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void withReason(
              () => controller.api.archivePrinter({ params: { id: printer.id }, body: { reason } }),
              t('printing.printers.archived', { name: printer.name }),
            );
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_STATION') {
      const { station } = open;
      dialog = (
        <ReasonDialog
          title={t('printing.archiveStation.title', { name: station.name })}
          description={t('printing.archiveStation.description')}
          label={t('printing.archiveStation.reason')}
          confirmLabel={t('printing.archiveStation.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void withReason(
              () => controller.api.archiveStation({ params: { id: station.id }, body: { reason } }),
              t('printing.stations.archived', { name: station.name }),
            );
          }}
          onClose={close}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-printing">
      <h2 id="dashboard-printing" className="dashboard-section__heading">
        {t('printing.title')}
      </h2>
      <p className="dashboard-section__hint">{t('printing.intro')}</p>
      {content}
      {dialog}
    </section>
  );
}

const PRINTER_OPENS = {
  EDIT: 'EDIT_PRINTER',
  REDIRECT: 'REDIRECT',
  UNREDIRECT: 'UNREDIRECT',
  ARCHIVE: 'ARCHIVE_PRINTER',
} as const;

const PRINTER_ACTION_LABELS = {
  EDIT: 'printing.printers.edit',
  REDIRECT: 'printing.printers.redirect',
  UNREDIRECT: 'printing.printers.unredirect',
  ARCHIVE: 'printing.printers.archive',
} as const;

/**
 * One printer: where it is and its paper, whether it prints (in words, not colour alone), where its
 * tickets go while it is sent elsewhere, the stations that print on it, and its actions.
 */
function PrinterRow({
  printer,
  printers,
  stations,
  now,
  testing,
  onTest,
  onAction,
}: {
  printer: PrinterView;
  printers: readonly PrinterView[];
  stations: readonly StationView[];
  now: Date;
  testing: boolean;
  onTest: () => void;
  onAction: (action: PrinterAction) => void;
}) {
  const t = useT();
  const health = printerHealthOf(printer);
  const usedBy = stationsPrintingOn(printer.id, stations).map((station) => station.name);
  const sentTo = printerNameOf(printers, printer.redirectToId);
  const where =
    printer.connection === 'NETWORK'
      ? t('printing.printers.network', {
          host: printer.host ?? '',
          port: String(printer.port ?? DEFAULT_PORT),
        })
      : t('printing.printers.usb', { host: printer.host ?? '' });
  const actions: readonly PrinterAction[] = [
    'EDIT',
    sentTo === undefined ? 'REDIRECT' : 'UNREDIRECT',
    'ARCHIVE',
  ];
  return (
    <li className="staff-row">
      <div className="staff-row__who">
        <h4 className="staff-row__name">{printer.name}</h4>
        <p className="staff-row__contact menu-facts">
          <span>{where}</span>
          <span>{t('printing.printers.paper', { width: printer.paperWidthMm })}</span>
        </p>
        <p className="staff-row__states">
          <Badge tone={HEALTH_TONES[health.kind]}>
            {t(`printing.printers.status.${health.kind}`)}
          </Badge>
          {sentTo === undefined ? null : (
            <Badge tone="warning">{t('printing.printers.sentElsewhere')}</Badge>
          )}
        </p>
        <HealthLine health={health} now={now} />
        {sentTo === undefined ? null : (
          <p className="staff-row__contact">
            {t('printing.printers.redirected', { name: sentTo })}
          </p>
        )}
        <p className="staff-row__contact">
          {usedBy.length === 0
            ? t('printing.printers.unused')
            : t('printing.printers.usedBy', { names: usedBy.join(', ') })}
        </p>
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('printing.printers.actionsFor', { name: printer.name })}
      >
        <Button variant="secondary" loading={testing} onClick={onTest}>
          {t('printing.printers.test')}
        </Button>
        {actions.map((action) => (
          <Button
            key={action}
            variant="secondary"
            onClick={() => {
              onAction(action);
            }}
          >
            {t(PRINTER_ACTION_LABELS[action])}
          </Button>
        ))}
      </div>
    </li>
  );
}

/** When the printer last printed, or since when it has not and why, in the restaurant's time. */
function HealthLine({ health, now }: { health: PrinterHealth; now: Date }) {
  const t = useT();
  if (health.kind === 'UNTRIED') return null;
  const at = lastSeenOf(health.kind === 'READY' ? health.lastSeenAt : health.since, now);
  let text: string;
  if (at.kind === 'NEVER') {
    return null;
  } else if (at.kind === 'TODAY') {
    text =
      health.kind === 'READY'
        ? t('printing.printers.lastPrintedToday', { time: at.time })
        : t('printing.printers.offlineToday', { time: at.time });
  } else {
    const when = { date: shortDateOf(at.date, t.locale), time: at.time };
    text =
      health.kind === 'READY'
        ? t('printing.printers.lastPrintedEarlier', when)
        : t('printing.printers.offlineEarlier', when);
  }
  const error = health.kind === 'OFFLINE' ? health.error : null;
  return <p className="staff-row__contact">{error === null ? text : `${text} ${error}`}</p>;
}

/** One station: how it gets its tickets, the printer it prints on and whether that one prints. */
function StationRow({
  station,
  printers,
  onEdit,
  onArchive,
}: {
  station: StationView;
  printers: readonly PrinterView[];
  onEdit: () => void;
  onArchive: () => void;
}) {
  const t = useT();
  const printer = printerOfStation(station, printers);
  return (
    <li className="staff-row">
      <div className="staff-row__who">
        <h4 className="staff-row__name">{station.name}</h4>
        <p className="settings-row__value">{t(`printing.stations.mode.${station.mode}`)}</p>
        {printer === undefined ? null : (
          <p className="staff-row__contact">
            {t('printing.stations.printsOn', { name: printer.name })}
          </p>
        )}
        {!isOffline(printer) ? null : (
          <p className="staff-row__states">
            <Badge tone="danger">
              {t('printing.stations.printerDown', { name: printer.name })}
            </Badge>
          </p>
        )}
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('printing.stations.actionsFor', { name: station.name })}
      >
        <Button variant="secondary" onClick={onEdit}>
          {t('printing.stations.edit')}
        </Button>
        <Button variant="secondary" onClick={onArchive}>
          {t('printing.stations.archive')}
        </Button>
      </div>
    </li>
  );
}
