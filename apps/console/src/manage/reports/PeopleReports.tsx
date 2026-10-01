import type { ShiftReportResponse, StaffPerformanceResponse } from '@rp/contracts';
import { displayDateTime, formatDisplayDate } from '@rp/domain';
import { Table } from '@rp/ui-web';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { axisRupees, duration, type ReportRange, rupees } from './report-view.js';
import {
  BarChartFigure,
  ExportButtons,
  moneyColumn,
  numberColumn,
  ReportBody,
  ReportSection,
  textColumn,
} from './ReportParts.js';
import { useReport } from './use-report.js';

type Slug = 'staff' | 'shifts';
type PersonRow = StaffPerformanceResponse['staff'][number];
type ShiftRow = ShiftReportResponse['shifts'][number];

/** RPT-003: each person's orders, approvals, sales, acknowledgements, escalations and voids. */
function StaffWork({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getStaffPerformance({ query: wanted }), range);
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-staff"
          title={t('reportsPage.report.staff')}
          action={<ExportButtons report="STAFF" range={range} />}
        >
          {report.staff.length === 0 ? null : (
            <BarChartFigure
              title={t('reportsPage.staff.chart')}
              horizontal
              data={[...report.staff]
                .sort((a, b) => b.net - a.net)
                .slice(0, 10)
                .map((person) => ({ key: person.staffId, label: person.name, value: person.net }))}
              format={rupees}
              axisFormat={(value) => axisRupees(value, t)}
            />
          )}
          <Table<PersonRow>
            caption={t('reportsPage.staff.table')}
            columns={[
              textColumn('name', t('reportsPage.columns.person'), (row) => row.name),
              textColumn('role', t('reportsPage.columns.role'), (row) => t(`roles.${row.role}`)),
              numberColumn('created', t('reportsPage.staff.created'), (row) => row.ordersCreated),
              numberColumn(
                'approved',
                t('reportsPage.staff.approved'),
                (row) => row.ordersApproved,
              ),
              moneyColumn('net', t('reportsPage.items.net'), (row) => row.net),
              numberColumn('acks', t('reportsPage.staff.acks'), (row) => row.acknowledgements),
              textColumn('ackTime', t('reportsPage.staff.ackTime'), (row) =>
                row.averageAckSeconds === null ? '–' : duration(row.averageAckSeconds, t),
              ),
              numberColumn(
                'escalations',
                t('reportsPage.staff.escalations'),
                (row) => row.escalations,
              ),
              numberColumn(
                'cancellations',
                t('reportsPage.staff.cancellations'),
                (row) => row.cancellations,
              ),
              numberColumn('voids', t('reportsPage.staff.voids'), (row) => row.voids),
            ]}
            rows={report.staff}
            rowKey={(row) => row.staffId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

/** RPT-005: shifts with the cash expected, counted and the difference. */
function Shifts({ range }: { range: ReportRange }) {
  const t = useT();
  const { api } = useConsole();
  const { data, reload } = useReport((wanted) => api.getShiftReport({ query: wanted }), range);
  const time = (at: string | null) => (at === null ? '–' : displayDateTime(new Date(at)).time);
  const signed = (value: number | null) =>
    value === null ? '–' : value < 0 ? `-${rupees(-value)}` : rupees(value);
  return (
    <ReportBody data={data} reload={reload}>
      {(report) => (
        <ReportSection
          id="report-shifts"
          title={t('reportsPage.report.shifts')}
          action={<ExportButtons report="SHIFTS" range={range} />}
        >
          <p className="settings-row__value">
            {t('reportsPage.shifts.variance', { amount: signed(report.totalVariance) })}
          </p>
          <Table<ShiftRow>
            caption={t('reportsPage.shifts.table')}
            columns={[
              textColumn('date', t('reportsPage.columns.date'), (row) =>
                formatDisplayDate(row.businessDate),
              ),
              textColumn('cashier', t('reportsPage.columns.person'), (row) => row.staffName),
              textColumn('opened', t('reportsPage.shifts.opened'), (row) => time(row.openedAt)),
              textColumn('closed', t('reportsPage.shifts.closed'), (row) => time(row.closedAt)),
              moneyColumn('float', t('reportsPage.shifts.float'), (row) => row.openingFloat),
              moneyColumn('cash', t('reportsPage.shifts.cash'), (row) => row.cashPayments),
              moneyColumn('in', t('reportsPage.shifts.in'), (row) => row.cashIn),
              moneyColumn('out', t('reportsPage.shifts.out'), (row) => row.cashOut),
              textColumn('expected', t('reportsPage.shifts.expected'), (row) =>
                signed(row.expectedCash),
              ),
              textColumn('counted', t('reportsPage.shifts.counted'), (row) =>
                signed(row.countedCash),
              ),
              textColumn('difference', t('reportsPage.shifts.difference'), (row) =>
                signed(row.variance),
              ),
            ]}
            rows={report.shifts}
            rowKey={(row) => row.shiftId}
            empty={t('reportsPage.none')}
          />
        </ReportSection>
      )}
    </ReportBody>
  );
}

export function PeopleReport({ slug, range }: { slug: Slug; range: ReportRange }) {
  return slug === 'staff' ? <StaffWork range={range} /> : <Shifts range={range} />;
}
