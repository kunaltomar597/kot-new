import { summarizeOrderFeed } from '@rp/domain';
import { floorSections, tileAlert, tileDetails } from '@rp/ordering';
import { Button, EmptyState, ErrorState, Icon, LoadingState, TableTile } from '@rp/ui-web';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAlerts } from '../alerts/alerts-context.js';
import { useT } from '../app/i18n.js';
import type { LiveData } from '../app/use-live.js';
import { messageOf } from '../app/messages.js';
import { useNow } from '../app/use-now.js';
import { type FloorData, useFloor } from '../pos/use-floor.js';
import { FILTER_PARAMS } from './order-feed-view.js';
import { type OrderFeedData, serverNow, useOrderFeed } from './use-order-feed.js';

/** Move "25 min" and the late marks on this often between reads. */
const CLOCK_MS = 15_000;

/**
 * The dashboard's first page (P4-01): the restaurant at a glance (tables and guests, orders in the
 * kitchen and late dishes, open alerts) and the live floor (MGR-002, TBL-007), both kept live by
 * events. Selecting an occupied table opens the order feed filtered to it.
 */
export function Overview() {
  const t = useT();
  const floor = useFloor();
  const feed = useOrderFeed();
  const now = useNow(CLOCK_MS);
  return (
    <>
      <section className="dashboard-section" aria-labelledby="dashboard-glance">
        <h2 id="dashboard-glance" className="dashboard-section__heading">
          {t('dashboard.overview.glance')}
        </h2>
        <ul className="dashboard-glance">
          <TablesGlance data={floor.data} reload={floor.reload} />
          <OrdersGlance data={feed.data} reload={feed.reload} now={now} />
          <AlertsGlance />
        </ul>
      </section>
      <FloorSection data={floor.data} reload={floor.reload} now={now} />
    </>
  );
}

function GlanceCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="glance-card">
      <h3 className="glance-card__title">{title}</h3>
      {children}
    </li>
  );
}

/** A card's words while its data is read, or why it could not be, with Retry. */
function GlancePending({
  data,
  reload,
}: {
  data: Exclude<LiveData<unknown>, { status: 'ready' }>;
  reload: () => void;
}) {
  const t = useT();
  if (data.status === 'loading') return <p className="glance-card__line">{t('states.loading')}</p>;
  return (
    <>
      <p className="glance-card__line">{messageOf(data.error, t)}</p>
      <Button variant="secondary" onClick={reload}>
        {t('states.retry')}
      </Button>
    </>
  );
}

function TablesGlance({ data, reload }: { data: FloorData; reload: () => void }) {
  const t = useT();
  if (data.status !== 'ready') {
    return (
      <GlanceCard title={t('dashboard.overview.tables')}>
        <GlancePending data={data} reload={reload} />
      </GlanceCard>
    );
  }
  const tables = floorSections(data.value.floor, data.value.overview).flatMap(
    (section) => section.tables,
  );
  const seated = tables.filter((table) => table.session !== null);
  const guests = seated.reduce((sum, table) => sum + (table.session?.covers ?? 0), 0);
  return (
    <GlanceCard title={t('dashboard.overview.tables')}>
      <p className="glance-card__value">
        {t('dashboard.overview.occupied', { occupied: seated.length, total: tables.length })}
      </p>
      <p className="glance-card__line">{t('dashboard.overview.guests', { count: guests })}</p>
    </GlanceCard>
  );
}

function OrdersGlance({
  data,
  reload,
  now,
}: {
  data: OrderFeedData;
  reload: () => void;
  now: number;
}) {
  const t = useT();
  if (data.status !== 'ready') {
    return (
      <GlanceCard title={t('dashboard.section.orders')}>
        <GlancePending data={data} reload={reload} />
      </GlanceCard>
    );
  }
  const { feed, receivedAt } = data.value;
  const summary = summarizeOrderFeed(feed.orders, serverNow(feed, receivedAt, now), feed.settings);
  const late = summary.delayed > 0;
  return (
    <GlanceCard title={t('dashboard.section.orders')}>
      <p className="glance-card__value">
        {t('dashboard.overview.orders', { count: summary.orders })}
      </p>
      {summary.awaitingApproval > 0 ? (
        <p className="glance-card__line">
          {t('dashboard.overview.awaiting', { count: summary.awaitingApproval })}
        </p>
      ) : null}
      <p className="glance-card__line">
        {t('dashboard.overview.inKitchen', { count: summary.inKitchen })}
      </p>
      <p className="glance-card__line">{t('dashboard.overview.ready', { count: summary.ready })}</p>
      <p className="glance-card__line" data-delayed={late || undefined}>
        {late ? <Icon name="warning" /> : null}
        {t('dashboard.overview.delayed', { count: summary.delayed })}
      </p>
      <p className="glance-card__links">
        <Link to="orders" className="glance-card__link">
          {t('dashboard.overview.seeOrders')}
        </Link>
        {late ? (
          <Link to={`orders?${FILTER_PARAMS.delayed}=1`} className="glance-card__link">
            {t('dashboard.overview.seeDelayed')}
          </Link>
        ) : null}
      </p>
    </GlanceCard>
  );
}

/** Every open alert the manager looks over (MGR-008); the header counts what asks for them. */
function AlertsGlance() {
  const t = useT();
  const state = useAlerts();
  if (state === null) return null;
  const { alerts, reload } = state;
  return (
    <GlanceCard title={t('dashboard.section.alerts')}>
      {alerts.status === 'ready' ? (
        <>
          <p className="glance-card__value">
            {t('dashboard.overview.alerts', { count: alerts.value.length })}
          </p>
          <p className="glance-card__links">
            <Link to="alerts" className="glance-card__link">
              {t('dashboard.overview.seeAlerts')}
            </Link>
          </p>
        </>
      ) : (
        <GlancePending data={alerts} reload={reload} />
      )}
    </GlanceCard>
  );
}

/**
 * The live floor (MGR-002): the POS's table overview (TBL-007) for looking, not serving. An
 * occupied table opens its orders; a free one has none, so it is not a button that does nothing.
 */
function FloorSection({ data, reload, now }: { data: FloorData; reload: () => void; now: number }) {
  const t = useT();
  const navigate = useNavigate();
  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={messageOf(data.error, t)}
        action={<Button onClick={reload}>{t('states.retry')}</Button>}
      />
    );
  } else {
    const sections = floorSections(data.value.floor, data.value.overview);
    content =
      sections.length === 0 ? (
        <EmptyState title={t('dashboard.overview.noTables')} />
      ) : (
        <>
          <p className="dashboard-section__hint">{t('dashboard.overview.tableHint')}</p>
          {sections.map((section) => (
            <section
              key={section.id}
              className="pos-floor__section"
              aria-label={section.name === '' ? t('pos.tables') : section.name}
            >
              {section.name === '' ? null : <h3 className="pos-floor__heading">{section.name}</h3>}
              <div className="pos-floor__tables">
                {section.tables.map((table) => {
                  const alert = tileAlert(table, t);
                  return (
                    <TableTile
                      key={table.tableId}
                      label={table.label}
                      state={table.state}
                      stateLabel={t(`pos.tableState.${table.state}`)}
                      details={tileDetails(table, now, t)}
                      {...(table.session !== null && { amountSoFar: table.session.amountSoFar })}
                      {...(alert !== undefined && { alert })}
                      toggle={false}
                      disabled={table.session === null}
                      onSelect={() => {
                        const search = new URLSearchParams({
                          [FILTER_PARAMS.table]: table.tableId,
                          [FILTER_PARAMS.tableLabel]: table.label,
                        });
                        void navigate(`orders?${search.toString()}`);
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </>
      );
  }
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-floor">
      <h2 id="dashboard-floor" className="dashboard-section__heading">
        {t('dashboard.overview.floor')}
      </h2>
      {content}
    </section>
  );
}
