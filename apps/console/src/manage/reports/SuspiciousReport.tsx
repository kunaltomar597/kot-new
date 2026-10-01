import type { SuspiciousActivityResponse } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import { Badge, Table } from '@rp/ui-web';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { flagFigure, flagSubject, percent, type ReportRange, rupees } from './report-view.js';
import {
  ExportButtons,
  nameOf,
  numberColumn,
  OrderLink,
  ReportBody,
  ReportSection,
  StatTiles,
  textColumn,
} from './ReportParts.js';
import { useReport } from './use-report.js';

type Flag = SuspiciousActivityResponse['flags'][number];
type Person = SuspiciousActivityResponse['people'][number];

const when = (at: string) => {
  const { date, time } = displayDateTime(new Date(at));
  return `${date} ${time}`;
};

/**
 * RPT-014 / AUD-006: what the daily report flags, for any range. One tile per pattern, every flag
 * with the person it is about (and who approved, and why), and the flags per person, so a manager
 * sees at a glance whose name keeps coming up.
 */
export function SuspiciousReport({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport(
    (wanted) => api.getSuspiciousActivityReport({ query: wanted }),
    range,
  );
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-suspicious"
          title={t('reportsPage.report.suspicious')}
          action={<ExportButtons report="SUSPICIOUS" range={range} />}
        >
          <p className="dashboard-section__hint">
            {t('reportsPage.suspicious.thresholds', {
              discount: percent(report.thresholds.discountFlagBp),
              cash: rupees(report.thresholds.cashVarianceFlagPaise),
              count: report.thresholds.reprintFlagCount,
            })}
          </p>
          <StatTiles
            stats={[
              { label: t('reportsPage.suspicious.total'), value: String(report.flags.length) },
              ...report.totals.map((total) => ({
                label: t(`reportsPage.suspicious.kinds.${total.kind}`),
                value: String(total.count),
              })),
            ]}
          />
          <Table<Flag>
            caption={t('reportsPage.suspicious.table')}
            columns={[
              textColumn('when', t('reportsPage.columns.when'), (row) => when(row.at)),
              textColumn('pattern', t('reportsPage.suspicious.pattern'), (row) => (
                <Badge tone="warning">{t(`reportsPage.suspicious.kinds.${row.kind}`)}</Badge>
              )),
              textColumn('what', t('reportsPage.suspicious.what'), (row) => flagSubject(row, t)),
              {
                key: 'detail',
                header: t('reportsPage.suspicious.detail'),
                align: 'end',
                cell: (row) => flagFigure(row, t),
              },
              textColumn('person', t('reportsPage.suspicious.person'), (row) =>
                row.alsoBy.length === 0 ? (
                  nameOf(row.by)
                ) : (
                  <>
                    {nameOf(row.by)}
                    <br />
                    <span className="dashboard-section__hint">
                      {t('reportsPage.suspicious.also', {
                        names: row.alsoBy.map((person) => person.name).join(', '),
                      })}
                    </span>
                  </>
                ),
              ),
              textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
                nameOf(row.approvedBy),
              ),
              textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
              textColumn('order', t('reportsPage.columns.order'), (row) => (
                <OrderLink orderId={row.orderId} />
              )),
            ]}
            rows={report.flags}
            rowKey={(row) => row.flagId}
            empty={t('reportsPage.suspicious.none')}
          />
          <Table<Person>
            caption={t('reportsPage.suspicious.people')}
            columns={[
              textColumn('person', t('reportsPage.suspicious.person'), (row) => row.name),
              numberColumn('flags', t('reportsPage.suspicious.flags'), (row) => row.count),
            ]}
            rows={report.people}
            rowKey={(row) => row.id}
            empty={t('reportsPage.suspicious.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}
