import type { PrinterView, StationView } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Badge, Button, EmptyState, ErrorState, LoadingState, useToast } from '@rp/ui-web';
import { type ReactNode, useCallback, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../menu/ReasonDialog.js';
import { PrinterDialog, RedirectDialog, StationDialog } from './PrintingDialogs.js';
import {
  activePrinters,
  activeStations,
  printerAddress,
  printerState,
  redirectTargets,
  stationsOn,
} from './printing-view.js';

type Open =
  | { readonly kind: 'ADD_PRINTER' | 'ADD_STATION' }
  | {
      readonly kind: 'EDIT_PRINTER' | 'REDIRECT' | 'STOP_REDIRECT' | 'ARCHIVE_PRINTER';
      readonly printer: PrinterView;
    }
  | { readonly kind: 'EDIT_STATION' | 'ARCHIVE_STATION'; readonly station: StationView };

const STATE_TONE = { ONLINE: 'success', OFFLINE: 'danger', UNTESTED: 'neutral' } as const;

/**
 * The kitchen stations and printers (P4-03d, KDS-002, KDS-008, ONB-004 step 6): each printer with
 * its address, paper, the stations it prints for and whether it prints, with a test page, and
 * each station with its mode and printer. A manager adds and changes both, archives them with a
 * reason, and sends a broken printer's tickets to another one. Changes and printer status follow
 * from any screen.
 */
export function PrintingScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    async () => {
      const [printers, stations] = await Promise.all([
        controller.api.listPrinters(),
        controller.api.listStations(),
      ]);
      return { printers: printers.printers, stations: stations.stations };
    },
    (type) => type === 'RestaurantChanged' || type === 'PrinterStatusChanged',
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [testing, setTesting] = useState<string | undefined>();

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Runs one change in a dialog, says what happened, and reads the lists again. */
  const change = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const testPrint = async (printer: PrinterView) => {
    setTesting(printer.id);
    try {
      const result = await controller.api.testPrinter({ params: { id: printer.id } });
      toast.show(
        result.printed
          ? {
              title: t('printing.printers.testPrinted', { name: printer.name }),
              tone: 'success',
            }
          : {
              title: t('printing.printers.testFailed', {
                name: printer.name,
                error: result.error ?? t('errors.generic'),
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
    const printers = activePrinters(data.value.printers);
    const stations = activeStations(data.value.stations);
    const nameOf = (id: string | null) =>
      data.value.printers.find((printer) => printer.id === id)?.name;
    content = (
      <>
        <section className="device-group" aria-labelledby="printing-printers">
          <div className="staff-header">
            <h3 id="printing-printers" className="device-group__heading">
              {t('printing.printers.title')}
            </h3>
            <Button
              onClick={() => {
                setOpen({ kind: 'ADD_PRINTER' });
              }}
            >
              {t('printing.printers.add')}
            </Button>
          </div>
          {printers.length === 0 ? (
            <EmptyState
              title={t('printing.printers.empty')}
              description={t('printing.printers.emptyHint')}
            />
          ) : (
            <ul className="staff-list" aria-labelledby="printing-printers">
              {printers.map((printer) => {
                const state = printerState(printer);
                const usedBy = stationsOn(printer.id, data.value.stations);
                const redirectedTo = nameOf(printer.redirectToId);
                let seen: string | undefined;
                if (printer.offlineSince !== null) {
                  seen = t(
                    'printing.printers.offlineSince',
                    displayDateTime(new Date(printer.offlineSince)),
                  );
                } else if (printer.lastSeenAt !== null) {
                  seen = t(
                    'printing.printers.lastSeen',
                    displayDateTime(new Date(printer.lastSeenAt)),
                  );
                }
                return (
                  <li key={printer.id} className="staff-row">
                    <div className="staff-row__who">
                      <h4 className="staff-row__name">{printer.name}</h4>
                      <p className="staff-row__role">
                        {[
                          t(`printing.printers.connection.${printer.connection}`),
                          printerAddress(printer),
                          t('printing.printers.paper', { width: printer.paperWidthMm }),
                        ].join(' · ')}
                      </p>
                      <p className="staff-row__contact">
                        {usedBy.length === 0
                          ? t('printing.printers.unused')
                          : t('printing.printers.usedBy', { list: usedBy.join(', ') })}
                      </p>
                      {seen === undefined ? null : <p className="staff-row__contact">{seen}</p>}
                      {state === 'OFFLINE' && printer.lastError !== null ? (
                        <p className="staff-row__contact">{printer.lastError}</p>
                      ) : null}
                      <p className="staff-row__states">
                        <Badge tone={STATE_TONE[state]}>
                          {t(`printing.printers.state.${state}`)}
                        </Badge>
                        {redirectedTo === undefined ? null : (
                          <Badge tone="warning">
                            {t('printing.printers.redirected', { name: redirectedTo })}
                          </Badge>
                        )}
                      </p>
                    </div>
                    <div
                      className="staff-row__actions"
                      role="group"
                      aria-label={t('printing.printers.actionsFor', { name: printer.name })}
                    >
                      <Button
                        variant="secondary"
                        loading={testing === printer.id}
                        onClick={() => {
                          void testPrint(printer);
                        }}
                      >
                        {t('printing.printers.test')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setOpen({ kind: 'EDIT_PRINTER', printer });
                        }}
                      >
                        {t('printing.printers.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setOpen({
                            kind: printer.redirectToId === null ? 'REDIRECT' : 'STOP_REDIRECT',
                            printer,
                          });
                        }}
                      >
                        {printer.redirectToId === null
                          ? t('printing.printers.redirect')
                          : t('printing.printers.stopRedirect')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setOpen({ kind: 'ARCHIVE_PRINTER', printer });
                        }}
                      >
                        {t('printing.printers.archive')}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="device-group" aria-labelledby="printing-stations">
          <div className="staff-header">
            <h3 id="printing-stations" className="device-group__heading">
              {t('printing.stations.title')}
            </h3>
            <Button
              onClick={() => {
                setOpen({ kind: 'ADD_STATION' });
              }}
            >
              {t('printing.stations.add')}
            </Button>
          </div>
          {stations.length === 0 ? (
            <EmptyState
              title={t('printing.stations.empty')}
              description={t('printing.stations.emptyHint')}
            />
          ) : (
            <ul className="staff-list" aria-labelledby="printing-stations">
              {stations.map((station) => {
                const printer = nameOf(station.printerId);
                return (
                  <li key={station.id} className="staff-row">
                    <div className="staff-row__who">
                      <h4 className="staff-row__name">{station.name}</h4>
                      <p className="staff-row__role">
                        {t(`printing.stations.mode.${station.mode}`)}
                      </p>
                      <p className="staff-row__contact">
                        {printer === undefined
                          ? t('printing.stations.noPrinter')
                          : t('printing.stations.printer', { name: printer })}
                      </p>
                    </div>
                    <div
                      className="staff-row__actions"
                      role="group"
                      aria-label={t('printing.stations.actionsFor', { name: station.name })}
                    >
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'EDIT_STATION', station });
                        }}
                      >
                        {t('printing.stations.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setOpen({ kind: 'ARCHIVE_STATION', station });
                        }}
                      >
                        {t('printing.stations.archive')}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </>
    );
  }

  const ready = data.status === 'ready' ? data.value : undefined;
  let dialog: ReactNode = null;
  if (open !== undefined && ready !== undefined) {
    const state = { busy, error, onClose: close };
    switch (open.kind) {
      case 'ADD_PRINTER':
      case 'EDIT_PRINTER': {
        const printer = open.kind === 'EDIT_PRINTER' ? open.printer : undefined;
        dialog = (
          <PrinterDialog
            {...state}
            printer={printer}
            onSave={(body) => {
              void change(
                () =>
                  printer === undefined
                    ? controller.api.createPrinter({ body })
                    : controller.api.updatePrinter({ params: { id: printer.id }, body }),
                printer === undefined
                  ? t('printing.printers.added', { name: body.name })
                  : t('printing.printers.saved', { name: body.name }),
              );
            }}
          />
        );
        break;
      }
      case 'ADD_STATION':
      case 'EDIT_STATION': {
        const station = open.kind === 'EDIT_STATION' ? open.station : undefined;
        const printers = activePrinters(ready.printers);
        const kept = ready.printers.find(
          (printer) => printer.id === station?.printerId && printer.archivedAt !== null,
        );
        dialog = (
          <StationDialog
            {...state}
            station={station}
            printers={kept === undefined ? printers : [...printers, kept]}
            onSave={(body) => {
              void change(
                () =>
                  station === undefined
                    ? controller.api.createStation({ body })
                    : controller.api.updateStation({ params: { id: station.id }, body }),
                station === undefined
                  ? t('printing.stations.added', { name: body.name })
                  : t('printing.stations.saved', { name: body.name }),
              );
            }}
          />
        );
        break;
      }
      case 'REDIRECT': {
        const { printer } = open;
        const targets = redirectTargets(printer, ready.printers);
        dialog = (
          <RedirectDialog
            {...state}
            printer={printer}
            targets={targets}
            onRedirect={(toPrinterId, reason) => {
              const target = targets.find((other) => other.id === toPrinterId)?.name ?? '';
              void change(
                () =>
                  controller.api.redirectPrinter({
                    params: { id: printer.id },
                    body: { toPrinterId, reason },
                  }),
                t('printing.printers.redirectedDone', { name: printer.name, target }),
              );
            }}
          />
        );
        break;
      }
      case 'STOP_REDIRECT': {
        const { printer } = open;
        dialog = (
          <ReasonDialog
            title={t('printing.stopRedirectDialog.title', { name: printer.name })}
            description={t('printing.stopRedirectDialog.description', {
              target: ready.printers.find((other) => other.id === printer.redirectToId)?.name ?? '',
            })}
            confirmLabel={t('printing.stopRedirectDialog.confirm')}
            tone="primary"
            hint={t('printing.reasonHint')}
            busy={busy}
            error={error}
            onConfirm={(reason) => {
              void change(
                () =>
                  controller.api.redirectPrinter({
                    params: { id: printer.id },
                    body: { toPrinterId: null, reason },
                  }),
                t('printing.printers.redirectStopped', { name: printer.name }),
              );
            }}
            onCancel={close}
          />
        );
        break;
      }
      case 'ARCHIVE_PRINTER':
      case 'ARCHIVE_STATION': {
        const isPrinter = 'printer' in open;
        const target = 'printer' in open ? open.printer : open.station;
        const copy = isPrinter ? 'archivePrinterDialog' : 'archiveStationDialog';
        dialog = (
          <ReasonDialog
            title={t(`printing.${copy}.title`, { name: target.name })}
            description={t(`printing.${copy}.description`)}
            confirmLabel={
              isPrinter ? t('printing.printers.archive') : t('printing.stations.archive')
            }
            hint={t('printing.reasonHint')}
            busy={busy}
            error={error}
            onConfirm={(reason) => {
              const params = { params: { id: target.id }, body: { reason } };
              void change(
                () =>
                  isPrinter
                    ? controller.api.archivePrinter(params)
                    : controller.api.archiveStation(params),
                isPrinter
                  ? t('printing.printers.archived', { name: target.name })
                  : t('printing.stations.archived', { name: target.name }),
              );
            }}
            onCancel={close}
          />
        );
        break;
      }
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
