import type { AuditEntryView, AuditListResponse, AuditVerifyResponse } from '@rp/contracts';
import { businessDateOf, displayDateTime } from '@rp/domain';
import { Badge, Button, ErrorState, LoadingState, Select, Table, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { RangeFilter } from '../reports/RangeFilter.js';
import {
  ExportButtons,
  nameOf,
  ReportBody,
  ReportSection,
  StatTiles,
  textColumn,
} from '../reports/ReportParts.js';
import { type ReportRange, rangeFromSearch } from '../reports/report-view.js';
import { useReport } from '../reports/use-report.js';
import { readable, recorded, shortId } from './audit-view.js';

/** Entries read at a time. */
export const AUDIT_PAGE = 100;

const when = (at: string) => {
  const { date, time } = displayDateTime(new Date(at));
  return `${date} ${time}`;
};

function Changes({ entry }: { entry: AuditEntryView }) {
  const t = useT();
  const before = recorded(entry.before);
  const after = recorded(entry.after);
  if (before === undefined && after === undefined) return null;
  return (
    <details className="audit-changes">
      <summary>{t('auditPage.changes')}</summary>
      {before === undefined ? null : (
        <>
          <p className="audit-changes__label">{t('auditPage.before')}</p>
          <pre className="audit-changes__value">{before}</pre>
        </>
      )}
      {after === undefined ? null : (
        <>
          <p className="audit-changes__label">{t('auditPage.after')}</p>
          <pre className="audit-changes__value">{after}</pre>
        </>
      )}
    </details>
  );
}

/** The chain check (AUD-003): recomputes every hash and says where it broke, if it did. */
function VerifyChain() {
  const t = useT();
  const { api } = useConsole();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuditVerifyResponse | undefined>();
  return (
    <ReportSection
      id="audit-verify"
      title={t('auditPage.verify.title')}
      action={
        <Button
          variant="secondary"
          loading={busy}
          onClick={() => {
            setBusy(true);
            api.verifyAuditChain().then(
              (answer) => {
                setResult(answer);
                setBusy(false);
              },
              (failure: unknown) => {
                toast.show({ title: messageOf(failure, t), tone: 'danger' });
                setBusy(false);
              },
            );
          }}
        >
          {t('auditPage.verify.run')}
        </Button>
      }
    >
      <p className="dashboard-section__hint">{t('auditPage.verify.hint')}</p>
      {result === undefined ? null : result.valid ? (
        <p role="status" className="console-notice">
          <Badge tone="success">{t('auditPage.verify.intact')}</Badge>{' '}
          {t('auditPage.verify.intactDetail', {
            count: result.checkedEntries,
            seq: result.head?.seq ?? 0,
            hash: result.head?.hash.slice(0, 12) ?? '',
          })}
        </p>
      ) : (
        <p role="alert" className="console-notice console-notice--danger">
          {t('auditPage.verify.broken', {
            seq: result.firstBreak?.seq ?? 0,
            reason: t(`auditPage.verify.reason.${result.firstBreak?.reason ?? 'HASH_MISMATCH'}`),
          })}
        </p>
      )}
    </ReportSection>
  );
}

function Entries({
  range,
  action,
  actorId,
  onFilter,
}: {
  range: ReportRange;
  action: string;
  actorId: string;
  onFilter: (filter: { action?: string; actorId?: string }) => void;
}) {
  const t = useT();
  const { api } = useConsole();
  const toast = useToast();
  const filters = {
    ...(action !== '' && { action }),
    ...(actorId !== '' && { actorId }),
  };
  const key = `${range.from}|${range.to}|${action}|${actorId}`;
  const { data, reload } = useReport(
    (wanted) => api.listAuditEntries({ query: { ...wanted, ...filters, limit: AUDIT_PAGE } }),
    range,
    key,
  );
  const [more, setMore] = useState<
    | { readonly key: string; readonly entries: AuditEntryView[]; readonly next: number | null }
    | undefined
  >();
  const [loadingMore, setLoadingMore] = useState(false);
  return (
    <ReportBody data={data} reload={reload}>
      {(audit: AuditListResponse) => {
        const extra = more?.key === key ? more : undefined;
        const entries = [...audit.entries, ...(extra?.entries ?? [])];
        const next = extra === undefined ? audit.nextOffset : extra.next;
        return (
          <ReportSection
            id="audit-entries"
            title={t('auditPage.entries')}
            action={<ExportButtons report="AUDIT" range={range} filters={filters} />}
          >
            <div className="report-filters" role="group" aria-label={t('auditPage.filters')}>
              <Select
                label={t('auditPage.action')}
                value={action}
                placeholder={t('auditPage.allActions')}
                options={audit.actions.map((code) => ({ value: code, label: readable(code) }))}
                onChange={(event) => {
                  onFilter({ action: event.target.value, actorId });
                }}
              />
              <Select
                label={t('auditPage.person')}
                value={actorId}
                placeholder={t('auditPage.everyone')}
                options={audit.people.map((person) => ({ value: person.id, label: person.name }))}
                onChange={(event) => {
                  onFilter({ action, actorId: event.target.value });
                }}
              />
            </div>
            <StatTiles stats={[{ label: t('auditPage.count'), value: String(audit.total) }]} />
            <Table<AuditEntryView>
              caption={t('auditPage.table')}
              columns={[
                textColumn('when', t('reportsPage.columns.when'), (row) => when(row.at)),
                textColumn('action', t('auditPage.action'), (row) => readable(row.action)),
                textColumn('record', t('auditPage.record'), (row) =>
                  row.entityId === null
                    ? readable(row.entityType)
                    : `${readable(row.entityType)} ${shortId(row.entityId)}`,
                ),
                textColumn('by', t('reportsPage.columns.by'), (row) => nameOf(row.actor)),
                textColumn('approved', t('reportsPage.columns.approvedBy'), (row) =>
                  nameOf(row.approver),
                ),
                textColumn('device', t('auditPage.device'), (row) => row.device?.name ?? '–'),
                textColumn('reason', t('reportsPage.columns.reason'), (row) => row.reason ?? '–'),
                textColumn('changes', t('auditPage.changes'), (row) => <Changes entry={row} />),
              ]}
              rows={entries}
              rowKey={(row) => row.id}
              empty={t('reportsPage.none')}
            />
            {next === null ? null : (
              <div className="staff-row__actions">
                <p className="dashboard-section__hint">
                  {t('auditPage.showing', { shown: entries.length, total: audit.total })}
                </p>
                <Button
                  variant="secondary"
                  loading={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    api
                      .listAuditEntries({
                        query: { ...range, ...filters, offset: next, limit: AUDIT_PAGE },
                      })
                      .then(
                        (page) => {
                          setMore({
                            key,
                            entries: [...(extra?.entries ?? []), ...page.entries],
                            next: page.nextOffset,
                          });
                        },
                        (failure: unknown) => {
                          toast.show({ title: messageOf(failure, t), tone: 'danger' });
                        },
                      )
                      .finally(() => {
                        setLoadingMore(false);
                      });
                  }}
                >
                  {t('auditPage.more')}
                </Button>
              </div>
            )}
          </ReportSection>
        );
      }}
    </ReportBody>
  );
}

/**
 * The audit trail (P4-07a, AUD-003, AUD-005): every audited action of a period, newest first,
 * with who did it, who approved it, on which device, why and what changed; filtered by action and
 * person, exported like a report, and the chain verified on request. Period and filters live in
 * the address.
 */
export function AuditScreen() {
  const t = useT();
  const controller = useConsole();
  const [search, setSearch] = useSearchParams();
  const { data: restaurant, reload } = useLive(
    () => controller.api.getRestaurant(),
    (type) => type === 'RestaurantChanged',
  );
  if (restaurant.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (restaurant.status === 'error') {
    return (
      <ErrorState
        title={t('auditPage.loadFailed')}
        description={messageOf(restaurant.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  }
  const today = businessDateOf(new Date(), {
    cutoff: restaurant.value.businessDayCutoff,
    timeZone: restaurant.value.timeZone,
  });
  const range = rangeFromSearch(search, today);
  const action = search.get('action') ?? '';
  const actorId = search.get('actorId') ?? '';
  const go = (next: { from: string; to: string; action: string; actorId: string }) => {
    setSearch({
      from: next.from,
      to: next.to,
      ...(next.action !== '' && { action: next.action }),
      ...(next.actorId !== '' && { actorId: next.actorId }),
    });
  };
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-audit">
      <h2 id="dashboard-audit" className="dashboard-section__heading">
        {t('auditPage.title')}
      </h2>
      <p className="dashboard-section__hint">{t('auditPage.intro')}</p>
      <RangeFilter
        key={`${range.from}|${range.to}`}
        range={range}
        today={today}
        onChange={(next) => {
          go({ ...next, action, actorId });
        }}
      />
      <Entries
        range={range}
        action={action}
        actorId={actorId}
        onFilter={(filter) => {
          go({ ...range, action: filter.action ?? '', actorId: filter.actorId ?? '' });
        }}
      />
      <VerifyChain />
    </section>
  );
}
