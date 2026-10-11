import { EXPORT_FORMATS, type ExportFormat, type ReportKind } from '@rp/contracts';
import { Button, ErrorState, LoadingState, type TableColumn, useToast } from '@rp/ui-web';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { useConsole } from '../../app/console-context.js';
import { downloadFile } from '../../app/download.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import type { ReportData } from './use-report.js';
import { type ReportRange, rupees } from './report-view.js';

/** A report's figures once loaded; the loading and error states otherwise. */
export function ReportBody<T>({
  data,
  reload,
  children,
}: {
  data: ReportData<T>;
  reload: () => void;
  children: (value: T) => ReactNode;
}) {
  const t = useT();
  if (data.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (data.status === 'error') {
    return (
      <ErrorState
        title={t('reportsPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  }
  return (
    <div className="report-body" aria-busy={data.refreshing} data-refreshing={data.refreshing}>
      {children(data.value)}
    </div>
  );
}

export interface Stat {
  readonly label: string;
  readonly value: string;
}

/** The headline figures of a report, each a label and a value (RPT-016). */
export function StatTiles({ stats }: { stats: readonly Stat[] }) {
  return (
    <dl className="report-stats">
      {stats.map((stat) => (
        <div key={stat.label} className="report-stat">
          <dt className="report-stat__label">{stat.label}</dt>
          <dd className="report-stat__value">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The width of an element, followed as it resizes (a fixed width where that cannot be read). */
function useWidth<E extends HTMLElement>(fallback: number) {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, width };
}

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/**
 * One measure as bars (RPT-016): a single series in the primary colour, hairline gridlines,
 * a tooltip on each bar, and the same figures in the table beside it. `horizontal` lists long
 * names down the side.
 */
export function BarChartFigure({
  title,
  data,
  format,
  axisFormat,
  horizontal = false,
}: {
  title: string;
  data: readonly BarDatum[];
  format: (value: number) => string;
  axisFormat: (value: number) => string;
  horizontal?: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(640);
  const height = horizontal ? Math.max(160, data.length * 32 + 40) : 240;
  return (
    <figure className="report-chart" ref={ref}>
      <figcaption className="report-chart__title">{title}</figcaption>
      <div role="img" aria-label={title}>
        <BarChart
          width={width}
          height={height}
          data={[...data]}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 8, right: 16, bottom: 8, left: horizontal ? 8 : 0 }}
          barCategoryGap="20%"
        >
          <CartesianGrid
            stroke="var(--rp-color-border)"
            strokeWidth={1}
            horizontal={!horizontal}
            vertical={horizontal}
          />
          {horizontal ? (
            <>
              <XAxis
                type="number"
                tickFormatter={axisFormat}
                stroke="var(--rp-color-text-muted)"
                tickLine={false}
                fontSize={12}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={140}
                stroke="var(--rp-color-text-muted)"
                tickLine={false}
                fontSize={12}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey="label"
                stroke="var(--rp-color-text-muted)"
                tickLine={false}
                fontSize={12}
                minTickGap={8}
              />
              <YAxis
                tickFormatter={axisFormat}
                stroke="var(--rp-color-text-muted)"
                tickLine={false}
                axisLine={false}
                fontSize={12}
                width={64}
              />
            </>
          )}
          <Tooltip
            cursor={{ fill: 'var(--rp-color-surface-sunken)' }}
            formatter={(value) => [format(Number(value)), title]}
            contentStyle={{
              background: 'var(--rp-color-surface-raised)',
              border: '1px solid var(--rp-color-border)',
              color: 'var(--rp-color-text)',
            }}
          />
          <Bar
            dataKey="value"
            fill="var(--rp-color-primary)"
            maxBarSize={24}
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </div>
    </figure>
  );
}

/** The file's bytes: CSV comes as text, Excel and PDF as base64. */
/**
 * Downloads a report as CSV, Excel or PDF, stamped and audited by the server (RPT-017, P4-06).
 * One button per format, so the choice is one tap.
 */
export function ExportButtons({
  report,
  range,
  filters = {},
}: {
  report: ReportKind;
  range: ReportRange;
  /** The audit log's action and person filters (AUDIT only). */
  filters?: { readonly action?: string; readonly actorId?: string };
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [busy, setBusy] = useState<ExportFormat | undefined>();
  return (
    <div className="report-exports" role="group" aria-label={t('reportsPage.export')}>
      <span className="report-exports__label" aria-hidden="true">
        {t('reportsPage.export')}
      </span>
      {EXPORT_FORMATS.map((format) => (
        <Button
          key={format}
          variant="secondary"
          loading={busy === format}
          disabled={busy !== undefined && busy !== format}
          aria-label={t('reportsPage.exportAs', { format: t(`reportsPage.format.${format}`) })}
          onClick={() => {
            setBusy(format);
            controller.api
              .exportReport({
                body: { report, from: range.from, to: range.to, format, ...filters },
              })
              .then(
                (file) => {
                  downloadFile(file);
                  toast.show({
                    title: t('reportsPage.exported', { file: file.filename }),
                    tone: 'success',
                  });
                },
                (failure: unknown) => {
                  toast.show({ title: messageOf(failure, t), tone: 'danger' });
                },
              )
              .finally(() => {
                setBusy(undefined);
              });
          }}
        >
          {t(`reportsPage.format.${format}`)}
        </Button>
      ))}
    </div>
  );
}

/** A report section: its heading, an optional action, and what goes under it. */
export function ReportSection({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="device-group" aria-labelledby={id}>
      <div className="staff-header">
        <h3 id={id} className="device-group__heading">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A link to everything about one order (RPT-015). */
export function OrderLink({ orderId, label }: { orderId: string | null; label?: string }) {
  const t = useT();
  if (orderId === null) return null;
  return (
    <Link to={`/manage/reports/orders/${orderId}`} className="staff-pages__link">
      {label ?? t('reportsPage.openOrder')}
    </Link>
  );
}

/** A person as reports name them, or a dash when nobody is recorded. */
export function nameOf(person: { readonly name: string } | null): string {
  return person?.name ?? '–';
}

/** A column of rupees, right-aligned so the digits line up. */
export function moneyColumn<Row>(
  key: string,
  header: string,
  pick: (row: Row) => number,
): TableColumn<Row> {
  return { key, header, align: 'end', cell: (row) => rupees(pick(row)) };
}

/** A column of counts or other plain numbers, right-aligned. */
export function numberColumn<Row>(
  key: string,
  header: string,
  pick: (row: Row) => number | string,
): TableColumn<Row> {
  return { key, header, align: 'end', cell: (row) => String(pick(row)) };
}

/** A column of text. */
export function textColumn<Row>(
  key: string,
  header: string,
  pick: (row: Row) => ReactNode,
): TableColumn<Row> {
  return { key, header, cell: pick };
}
