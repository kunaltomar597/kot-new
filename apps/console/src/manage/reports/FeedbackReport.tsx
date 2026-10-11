import type { FeedbackReportResponse } from '@rp/contracts';
import { displayDateTime, formatDisplayDate } from '@rp/domain';
import { Badge, Table } from '@rp/ui-web';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import type { ReportRange } from './report-view.js';
import {
  BarChartFigure,
  ExportButtons,
  numberColumn,
  ReportBody,
  ReportSection,
  StatTiles,
  textColumn,
} from './ReportParts.js';
import { useReport } from './use-report.js';

type Entry = FeedbackReportResponse['entries'][number];
type Day = FeedbackReportResponse['byDay'][number];

/** Hundredths of a star as "4.25". */
const stars = (hundredths: number | null) =>
  hundredths === null ? null : (hundredths / 100).toFixed(2);

/**
 * RPT-013: what diners said after the bill (TAB-014). The averages, the food rating day by day,
 * and every comment with its table; never a diner's number.
 */
export function FeedbackReport({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getFeedbackReport({ query: wanted }), range);
  const average = (hundredths: number | null) => {
    const value = stars(hundredths);
    return value === null
      ? t('reportsPage.feedback.noRating')
      : t('reportsPage.feedback.average', { value });
  };
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-feedback"
          title={t('reportsPage.report.feedback')}
          action={<ExportButtons report="FEEDBACK" range={range} />}
        >
          <StatTiles
            stats={[
              { label: t('reportsPage.feedback.count'), value: String(report.count) },
              { label: t('reportsPage.feedback.food'), value: average(report.averageFood) },
              { label: t('reportsPage.feedback.service'), value: average(report.averageService) },
            ]}
          />
          {report.byDay.length > 1 ? (
            <BarChartFigure
              title={t('reportsPage.feedback.chart')}
              data={report.byDay.map((day) => ({
                key: day.businessDate,
                label: formatDisplayDate(day.businessDate).slice(0, 5),
                value: (day.averageFood ?? 0) / 100,
              }))}
              format={(value) => value.toFixed(2)}
              axisFormat={(value) => value.toFixed(1)}
            />
          ) : null}
          <Table<Day>
            caption={t('reportsPage.feedback.table2')}
            columns={[
              textColumn('date', t('reportsPage.columns.date'), (row) =>
                formatDisplayDate(row.businessDate),
              ),
              numberColumn('count', t('reportsPage.feedback.count'), (row) => row.count),
              textColumn('food', t('reportsPage.feedback.food'), (row) => average(row.averageFood)),
              textColumn('service', t('reportsPage.feedback.service'), (row) =>
                average(row.averageService),
              ),
            ]}
            rows={report.byDay}
            rowKey={(row) => row.businessDate}
            empty={t('reportsPage.none')}
          />
          <Table<Entry>
            caption={t('reportsPage.feedback.table')}
            columns={[
              textColumn('when', t('reportsPage.columns.when'), (row) => {
                const { date, time } = displayDateTime(new Date(row.createdAt));
                return `${date} ${time}`;
              }),
              textColumn('table', t('reportsPage.columns.table'), (row) => row.tableLabel ?? '–'),
              numberColumn('food', t('reportsPage.feedback.food'), (row) => row.foodRating),
              numberColumn(
                'service',
                t('reportsPage.feedback.service'),
                (row) => row.serviceRating,
              ),
              textColumn(
                'comment',
                t('reportsPage.columns.comment'),
                (row) => row.comment ?? t('reportsPage.feedback.noComment'),
              ),
              textColumn('contact', t('reportsPage.feedback.contact'), (row) =>
                row.hasContact ? (
                  <Badge tone="info">{t('reportsPage.feedback.contact')}</Badge>
                ) : null,
              ),
            ]}
            rows={report.entries}
            rowKey={(row) => row.id}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}
