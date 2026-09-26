import type { KdsTicket, KdsTicketLine, KdsTicketsResponse } from '@rp/contracts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  LoadingState,
  Sheet,
  StatusChip,
  useToast,
} from '@rp/ui-web';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConsole, useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useLive } from '../app/use-live.js';
import { useNow } from '../app/use-now.js';
import {
  type AgeTone,
  ageTone,
  allDaySummary,
  arrivals,
  canBump,
  groupLines,
  type KitchenStep,
  linesFor,
  minutesBetween,
  nextStep,
  notCollected,
  ticketStep,
} from './kds-view.js';
import { type KitchenSounds, webAudioSounds } from './sounds.js';

const AGE_ICONS: Readonly<Record<AgeTone, IconName>> = {
  fresh: 'clock',
  amber: 'warning',
  red: 'flame',
};
const AGE_BADGE: Readonly<Record<AgeTone, 'success' | 'warning' | 'danger'>> = {
  fresh: 'success',
  amber: 'warning',
  red: 'danger',
};

const affectsKds = (type: string) =>
  /^(KotCreated|KotBumped|ItemStatusChanged|TableMoved|OrderApproved|SettingsChanged)$/.test(type);

/**
 * The kitchen display (P1-09b, KDS-001 to KDS-012): a station's tickets oldest first with their
 * live age, items grouped by combo and each item's state; steps per item and per ticket, bump and
 * recall, the pass's pick-up, "Notify manager" when ready food waits, sounds for new tickets and
 * changes, and a full-screen notice while the server is unreachable. Everything is read again
 * after kitchen events and after a reconnect, so nothing is lost or shown twice.
 */
export function KdsScreen({ sounds: given }: { sounds?: KitchenSounds }) {
  const t = useT();
  const controller = useConsole();
  const { connection } = useConsoleState();
  const toast = useToast();
  const sounds = useMemo(() => given ?? webAudioSounds(), [given]);
  const { data, reload } = useLive(async () => {
    const value = await controller.api.getKdsTickets({ query: {} });
    return { value, receivedAt: Date.now() };
  }, affectsKds);
  const now = useNow(15_000);
  const [soundOn, setSoundOn] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [recallOpen, setRecallOpen] = useState(false);
  const known = useRef<Set<string> | undefined>(undefined);

  // Sounds for tickets this screen had not seen (KDS-009); the first read is silent.
  const current = data.status === 'ready' ? data.value.value : undefined;
  useEffect(() => {
    if (current === undefined) return;
    const heard = arrivals(known.current, current.tickets);
    if (soundOn && heard.changes > 0) sounds.change(current.settings.soundVolumePercent);
    else if (soundOn && heard.newTickets > 0) sounds.newTicket(current.settings.soundVolumePercent);
    known.current = new Set([...current.tickets, ...current.recentlyBumped].map((t2) => t2.kotId));
  }, [current, sounds, soundOn]);

  const enableSound = () => {
    sounds.unlock();
    setSoundOn(true);
  };

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy((previous) => new Set(previous).add(key));
    try {
      await action();
    } catch (error) {
      toast.show({ title: messageOf(error, t), tone: 'danger' });
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      reload();
    }
  };

  const step = (line: KdsTicketLine, event: KitchenStep) =>
    controller.api.setOrderItemStatus({
      params: { orderItemId: line.orderItemId },
      body: { event },
    });

  const offline = connection === 'offline';

  return (
    // The first touch anywhere turns the sound on (browsers need a gesture before playing audio).
    <div className="kds" onPointerDown={soundOn ? undefined : enableSound}>
      {offline ? (
        <div className="kds-disconnected" role="alert">
          <Icon name="offline" size="4rem" />
          <h2 className="kds-disconnected__title">{t('kds.disconnectedTitle')}</h2>
          <p>{t('kds.disconnected')}</p>
          <p>{t('kds.reconnecting')}</p>
        </div>
      ) : null}
      {data.status === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
      {data.status === 'error' ? (
        <ErrorState
          title={messageOf(data.error, t)}
          action={<Button onClick={reload}>{t('states.retry')}</Button>}
        />
      ) : null}
      {current === undefined || data.status !== 'ready' ? null : (
        <Board
          view={current}
          // The server's clock, moved on by the time since the answer arrived (KDS-004).
          nowMs={Date.parse(current.serverTime) + Math.max(0, now - data.value.receivedAt)}
          busy={busy}
          soundOn={soundOn}
          onEnableSound={enableSound}
          onOpenRecall={() => {
            setRecallOpen(true);
          }}
          onStep={(ticket, line, event) => {
            void run(ticket.kotId, () => step(line, event));
          }}
          onTicketStep={(ticket, event) => {
            // Every item is tried even when one is refused (another screen may have moved it);
            // the first refusal is then shown.
            void run(ticket.kotId, async () => {
              const failures: unknown[] = [];
              for (const line of linesFor(ticket, event)) {
                await step(line, event).catch((error: unknown) => failures.push(error));
              }
              if (failures.length > 0) throw failures[0];
            });
          }}
          onBump={(ticket) => {
            void run(ticket.kotId, () =>
              controller.api.bumpKot({ params: { kotId: ticket.kotId } }),
            );
          }}
          onNotify={(ticket) => {
            void run(ticket.kotId, () =>
              controller.api.notifyManagerForKot({ params: { kotId: ticket.kotId } }),
            );
          }}
        />
      )}
      {recallOpen && current !== undefined ? (
        <Sheet
          open
          side="end"
          title={t('kds.recallTitle')}
          onClose={() => {
            setRecallOpen(false);
          }}
        >
          {current.recentlyBumped.length === 0 ? (
            <p>{t('kds.recallNone')}</p>
          ) : (
            <ul className="kds-recall">
              {current.recentlyBumped.map((ticket) => (
                <li key={ticket.kotId} className="kds-recall__item">
                  <span>
                    {t('kds.ticket', { number: ticket.kotNumber })} · {destination(ticket, t)}
                  </span>
                  <Button
                    variant="secondary"
                    aria-label={t('kds.recallFor', { number: ticket.kotNumber })}
                    disabled={busy.has(ticket.kotId)}
                    onClick={() => {
                      void run(ticket.kotId, () =>
                        controller.api.recallKot({ params: { kotId: ticket.kotId } }),
                      );
                    }}
                  >
                    {t('kds.recall')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}

function destination(ticket: KdsTicket, t: ReturnType<typeof useT>): string {
  if (ticket.tableLabel !== null) return t('kds.table', { table: ticket.tableLabel });
  if (ticket.takeawayToken !== null) return t('kds.token', { token: ticket.takeawayToken });
  return '';
}

interface BoardProps {
  view: KdsTicketsResponse;
  nowMs: number;
  busy: ReadonlySet<string>;
  soundOn: boolean;
  onEnableSound: () => void;
  onOpenRecall: () => void;
  onStep: (ticket: KdsTicket, line: KdsTicketLine, event: KitchenStep) => void;
  onTicketStep: (ticket: KdsTicket, event: 'START_PREPARING' | 'MARK_READY') => void;
  onBump: (ticket: KdsTicket) => void;
  onNotify: (ticket: KdsTicket) => void;
}

function Board(props: BoardProps) {
  const t = useT();
  const { view } = props;
  const summary = allDaySummary(view.tickets);
  return (
    <div className="kds-board">
      <header className="kds-board__bar">
        <h2 className="kds-board__station">{view.station?.name ?? t('kds.allStations')}</h2>
        {props.soundOn ? null : (
          <Button
            variant="secondary"
            startIcon={<Icon name="bell" />}
            onClick={props.onEnableSound}
          >
            {t('kds.enableSound')}
          </Button>
        )}
        <Button variant="secondary" startIcon={<Icon name="sync" />} onClick={props.onOpenRecall}>
          {t('kds.recall')}
        </Button>
      </header>
      <div className="kds-board__body">
        {view.tickets.length === 0 ? (
          <EmptyState title={t('kds.noTickets')} />
        ) : (
          <div className="kds-tickets">
            {view.tickets.map((ticket) => (
              <TicketCard key={ticket.kotId} ticket={ticket} {...props} />
            ))}
          </div>
        )}
        <aside className="kds-summary" aria-label={t('kds.summary')}>
          <h3 className="kds-summary__title">{t('kds.summary')}</h3>
          {summary.length === 0 ? (
            <p>{t('kds.summaryNone')}</p>
          ) : (
            <ul className="kds-summary__list">
              {summary.map((entry) => (
                <li key={entry.name}>
                  <strong>{entry.quantity}</strong> × {entry.name}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

function TicketCard({ ticket, ...props }: BoardProps & { ticket: KdsTicket }) {
  const t = useT();
  const { settings } = props.view;
  const minutes = minutesBetween(ticket.createdAt, props.nowMs);
  const tone = ageTone(minutes, settings);
  const waiting = notCollected(ticket, props.nowMs, settings);
  const busy = props.busy.has(ticket.kotId);
  const wide = ticketStep(ticket);
  const title = [t('kds.ticket', { number: ticket.kotNumber }), destination(ticket, t)]
    .filter(Boolean)
    .join(', ');
  return (
    <article
      className="kds-ticket"
      aria-label={title}
      data-age={tone}
      data-kind={ticket.kind}
      data-alert={waiting || undefined}
    >
      <header className="kds-ticket__header">
        <h3 className="kds-ticket__title">
          <span>{t('kds.ticket', { number: ticket.kotNumber })}</span>
          <span className="kds-ticket__destination">{destination(ticket, t)}</span>
        </h3>
        <Badge tone={AGE_BADGE[tone]} variant="solid" icon={<Icon name={AGE_ICONS[tone]} />}>
          {t('kds.ageMinutes', { minutes })}
          {tone === 'fresh' ? null : ` · ${t(`kds.age.${tone}`)}`}
        </Badge>
        <p className="kds-ticket__meta">
          {[ticket.waiterName, t(`kds.source.${ticket.source}`)].filter(Boolean).join(' · ')}
        </p>
        <div className="kds-ticket__badges">
          {ticket.movedFrom === null ? null : (
            <Badge tone="info">{t('kds.badge.moved', { table: ticket.movedFrom })}</Badge>
          )}
          {ticket.kind === 'NEW' ? null : (
            <Badge tone={ticket.kind === 'CANCELLED' ? 'danger' : 'warning'} variant="solid">
              {t(`kds.badge.${ticket.kind}`)}
            </Badge>
          )}
        </div>
      </header>
      <div className="kds-ticket__lines">
        {groupLines(ticket.lines).map((group, index) => (
          <div key={`${String(index)}-${group.comboName ?? ''}`} className="kds-group">
            {group.comboName === null ? null : (
              <p className="kds-group__combo">{group.comboName}</p>
            )}
            <ul className="kds-lines" data-combo={group.comboName !== null || undefined}>
              {group.lines.map((line) => {
                const next = ticket.kind === 'NEW' ? nextStep(line.state) : undefined;
                return (
                  <li key={`${line.orderItemId}-${String(line.quantity)}`} className="kds-line">
                    <div className="kds-line__main">
                      <span className="kds-line__name">
                        <strong>{line.quantity}</strong> × {line.name}
                        {line.variantName === null ? '' : ` (${line.variantName})`}
                      </span>
                      {line.modifiers.length === 0 ? null : (
                        <span className="kds-line__modifiers">{line.modifiers.join(', ')}</span>
                      )}
                      {line.instructions === null ? null : (
                        <span className="kds-line__note">{line.instructions}</span>
                      )}
                    </div>
                    <StatusChip state={line.state} label={t(`pos.itemState.${line.state}`)} />
                    {next === undefined ? null : (
                      <Button
                        variant={next === 'PICK_UP' ? 'secondary' : 'primary'}
                        aria-label={t('kds.stepFor', {
                          step: t(`kds.step.${next}`),
                          item: line.name,
                        })}
                        disabled={busy}
                        onClick={() => {
                          props.onStep(ticket, line, next);
                        }}
                      >
                        {t(`kds.step.${next}`)}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <footer className="kds-ticket__footer">
        {waiting ? (
          <p className="kds-ticket__alert" role="status">
            <Icon name="bell" />
            {ticket.managerNotified ? t('kds.managerNotified') : t('kds.notCollected')}
          </p>
        ) : null}
        {waiting && !ticket.managerNotified ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              props.onNotify(ticket);
            }}
          >
            {t('kds.notifyManager')}
          </Button>
        ) : null}
        {wide === undefined ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              props.onTicketStep(ticket, wide);
            }}
          >
            {wide === 'START_PREPARING' ? t('kds.allPreparing') : t('kds.allReady')}
          </Button>
        )}
        <Button
          variant="secondary"
          aria-label={t('kds.bumpFor', { number: ticket.kotNumber })}
          disabled={busy || !canBump(ticket)}
          onClick={() => {
            props.onBump(ticket);
          }}
        >
          {t('kds.bump')}
        </Button>
      </footer>
    </article>
  );
}
