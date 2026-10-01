import type { OrderDrillDownResponse } from '@rp/contracts';
import { displayDateTime, formatDisplayDate } from '@rp/domain';
import { Button, ErrorState, LoadingState, Table } from '@rp/ui-web';
import { useNavigate, useParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { rupees } from './report-view.js';
import { nameOf, ReportSection, textColumn } from './ReportParts.js';

type ItemRow = OrderDrillDownResponse['items'][number];
type KotRow = OrderDrillDownResponse['kots'][number];
type HistoryRow = OrderDrillDownResponse['history'][number];
type AuditRow = OrderDrillDownResponse['audit'][number];
type InvoiceRow = OrderDrillDownResponse['invoices'][number];
type ApprovalRow = OrderDrillDownResponse['approvals'][number];

const time = (at: string | null) => (at === null ? '–' : displayDateTime(new Date(at)).time);
const when = (at: string | null) => {
  if (at === null) return '–';
  const { date, time: clock } = displayDateTime(new Date(at));
  return `${date} ${clock}`;
};

/**
 * Everything about one order (RPT-015): who created it on which device and who approved it,
 * each dish's status times, the kitchen tickets, every change with who made it and why, and the
 * bills with who issued, printed, settled or voided them.
 */
export function OrderDrillDownScreen() {
  const t = useT();
  const controller = useConsole();
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  const { data, reload } = useLive(
    () => controller.api.getOrderDrillDown({ params: { orderId } }),
    () => false,
  );
  if (data.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (data.status === 'error') {
    return (
      <ErrorState
        title={t('reportsPage.order.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  }
  const order = data.value;
  const where =
    order.tableLabel === null
      ? order.takeawayToken === null
        ? t(`reportsPage.orderType.${order.orderType}`)
        : t('reportsPage.order.token', { token: order.takeawayToken })
      : t('reportsPage.order.table', { table: order.tableLabel });
  return (
    <ReportSection
      id="report-order"
      title={t('reportsPage.order.title', { number: order.orderNumber })}
      action={
        <Button
          variant="ghost"
          onClick={() => {
            void navigate(-1);
          }}
        >
          {t('reportsPage.order.back')}
        </Button>
      }
    >
      <dl className="restaurant-facts">
        {(
          [
            [t('reportsPage.columns.date'), formatDisplayDate(order.businessDate)],
            [t('reportsPage.order.where'), where],
            [t('reportsPage.columns.source'), t(`reportsPage.source.${order.source}`)],
            [t('reportsPage.order.created'), when(order.createdAt)],
            [t('reportsPage.order.createdBy'), nameOf(order.createdBy)],
            [
              t('reportsPage.order.device'),
              order.device === null
                ? '–'
                : `${order.device.name} (${t(`devices.typeOne.${order.device.type}`)})`,
            ],
          ] as const
        ).map(([term, value]) => (
          <div key={term} className="restaurant-facts__row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {order.approvals.length === 0 ? null : (
        <Table<ApprovalRow>
          caption={t('reportsPage.order.approvals')}
          columns={[
            textColumn('action', t('reportsPage.order.action'), (row) => row.action),
            textColumn('status', t('reportsPage.columns.status'), (row) => row.status),
            textColumn('requested', t('reportsPage.order.requestedBy'), (row) =>
              nameOf(row.requestedBy),
            ),
            textColumn('decided', t('reportsPage.order.decidedBy'), (row) => nameOf(row.decidedBy)),
            textColumn('at', t('reportsPage.columns.when'), (row) =>
              when(row.decidedAt ?? row.requestedAt),
            ),
            textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
          ]}
          rows={order.approvals}
          rowKey={(row) => `${row.action}|${row.requestedAt}`}
        />
      )}
      <Table<ItemRow>
        caption={t('reportsPage.order.items')}
        columns={[
          textColumn('dish', t('reportsPage.columns.dish'), (row) =>
            row.variantName === null ? row.name : `${row.name} (${row.variantName})`,
          ),
          textColumn('quantity', t('reportsPage.columns.quantity'), (row) => String(row.quantity)),
          textColumn('state', t('reportsPage.columns.status'), (row) =>
            t(`reportsPage.itemState.${row.state}`),
          ),
          textColumn('by', t('reportsPage.order.takenBy'), (row) =>
            row.approvedBy === null
              ? nameOf(row.createdBy)
              : t('reportsPage.order.approvedByName', { name: nameOf(row.approvedBy) }),
          ),
          textColumn('sent', t('reportsPage.order.sent'), (row) => time(row.sentAt)),
          textColumn('preparing', t('reportsPage.order.preparing'), (row) => time(row.preparingAt)),
          textColumn('ready', t('reportsPage.order.ready'), (row) => time(row.readyAt)),
          textColumn('picked', t('reportsPage.order.pickedUp'), (row) => time(row.pickedUpAt)),
          textColumn('served', t('reportsPage.order.served'), (row) => time(row.servedAt)),
          textColumn('ended', t('reportsPage.order.ended'), (row) =>
            row.endedAt === null ? '–' : `${time(row.endedAt)} ${row.endReason ?? ''}`.trim(),
          ),
        ]}
        rows={order.items}
        rowKey={(row) => row.orderItemId}
        empty={t('reportsPage.none')}
      />
      <Table<KotRow>
        caption={t('reportsPage.order.kots')}
        columns={[
          textColumn('number', t('reportsPage.order.kot'), (row) => String(row.kotNumber)),
          textColumn('kind', t('reportsPage.order.kind'), (row) =>
            t(`reportsPage.kotKind.${row.kind}`),
          ),
          textColumn('station', t('reportsPage.columns.station'), (row) => row.station),
          textColumn('created', t('reportsPage.columns.when'), (row) => time(row.createdAt)),
          textColumn('printed', t('reportsPage.order.printed'), (row) => time(row.printedAt)),
        ]}
        rows={order.kots}
        rowKey={(row) => row.kotId}
        empty={t('reportsPage.none')}
      />
      <Table<InvoiceRow>
        caption={t('reportsPage.order.invoices')}
        columns={[
          textColumn('number', t('reportsPage.columns.invoice'), (row) => row.invoiceNumber),
          textColumn('status', t('reportsPage.columns.status'), (row) =>
            t(`reportsPage.invoiceStatus.${row.status}`),
          ),
          textColumn('total', t('reportsPage.columns.total'), (row) => rupees(row.grandTotal)),
          textColumn(
            'issued',
            t('reportsPage.order.issued'),
            (row) => `${time(row.issuedAt)} ${nameOf(row.issuedBy)}`,
          ),
          textColumn('printed', t('reportsPage.order.printedBy'), (row) =>
            row.printCount === 0
              ? '–'
              : t('reportsPage.order.prints', {
                  name: nameOf(row.printedBy),
                  count: row.printCount,
                }),
          ),
          textColumn('settled', t('reportsPage.order.settled'), (row) =>
            row.settledAt === null ? '–' : `${time(row.settledAt)} ${nameOf(row.settledBy)}`,
          ),
          textColumn('voided', t('reportsPage.order.voided'), (row) =>
            row.voidedAt === null
              ? '–'
              : [time(row.voidedAt), nameOf(row.voidedBy), row.voidReason ?? ''].join(' ').trim(),
          ),
        ]}
        rows={order.invoices}
        rowKey={(row) => row.invoiceId}
        empty={t('reportsPage.none')}
      />
      <Table<HistoryRow>
        caption={t('reportsPage.order.history')}
        columns={[
          textColumn('at', t('reportsPage.columns.when'), (row) => time(row.at)),
          textColumn('event', t('reportsPage.order.event'), (row) =>
            [
              row.itemName,
              row.fromState === null || row.toState === null
                ? row.event
                : t('reportsPage.order.stateChange', {
                    from: t(`reportsPage.itemState.${row.fromState}`),
                    to: t(`reportsPage.itemState.${row.toState}`),
                  }),
            ]
              .filter(Boolean)
              .join(': '),
          ),
          textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.by)),
          textColumn('device', t('reportsPage.order.device'), (row) => row.device?.name ?? '–'),
          textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
        ]}
        rows={order.history}
        rowKey={(row) => `${row.at}|${row.event}|${row.orderItemId ?? ''}`}
        empty={t('reportsPage.none')}
      />
      <Table<AuditRow>
        caption={t('reportsPage.order.audit')}
        columns={[
          textColumn('at', t('reportsPage.columns.when'), (row) => time(row.at)),
          textColumn('action', t('reportsPage.order.action'), (row) => row.action),
          textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.by)),
          textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
            nameOf(row.approvedBy),
          ),
          textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
        ]}
        rows={order.audit}
        rowKey={(row) => `${row.at}|${row.action}|${row.entityId ?? ''}`}
        empty={t('reportsPage.none')}
      />
    </ReportSection>
  );
}
