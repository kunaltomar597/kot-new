import type { InvoiceSeriesView, RestaurantProfile, TaxGroupView } from '@rp/contracts';
import { calendarDateOf, grantOf } from '@rp/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import { percentOf } from './settings-view.js';
import { LegalDialog, SeriesDialog, TaxGroupDialog } from './TaxDialogs.js';
import { shown } from './tax-view.js';

interface TaxData {
  readonly profile: RestaurantProfile;
  readonly taxGroups: readonly TaxGroupView[];
  readonly series: readonly InvoiceSeriesView[];
}

/**
 * Setup changes, menu changes (the menu items each tax group has) and bills printed (each prints
 * an invoice, which fixes its series' format).
 */
const AFFECTS = new Set(['RestaurantChanged', 'MenuDraftChanged', 'MenuPublished', 'BillPrinted']);

type Open =
  | { readonly kind: 'LEGAL' | 'ADD_GROUP' | 'ADD_SERIES' }
  | { readonly kind: 'EDIT_GROUP' | 'ARCHIVE_GROUP'; readonly group: TaxGroupView }
  | {
      readonly kind: 'EDIT_SERIES' | 'ARCHIVE_SERIES' | 'DEFAULT_SERIES';
      readonly series: InvoiceSeriesView;
    };

/**
 * The Tax and invoice page (P4-03e, MGR-007, ONB-004 steps 1 to 3): the particulars printed on
 * every tax invoice (BILL-002), the tax groups with their rates (BILL-004) and the invoice series
 * with how their numbers look (BILL-003). Only the Owner changes them, confirming their password
 * and an authenticator code when the server asks (AUTH-006); everyone else who opens Settings sees
 * them, with a note saying so. The server audits every change and announces it, and the page
 * follows changes made elsewhere.
 */
export function TaxScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const { data, reload } = useLive(
    async (): Promise<TaxData> => {
      const [profile, groups, series] = await Promise.all([
        controller.api.getRestaurant(),
        controller.api.listTaxGroups(),
        controller.api.listInvoiceSeries(),
      ]);
      return { profile, taxGroups: groups.taxGroups, series: series.invoiceSeries };
    },
    (type) => AFFECTS.has(type),
  );
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Only the Owner, whatever a custom role says (AUTH-012); the server checks it on every call.
  const changes = person !== undefined && grantOf(person, 'TAX_AND_INVOICE_SETTINGS') === 'ALLOW';

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
  /** A change asked for in a confirmation, with the second factor: its refusal stays there. */
  const confirmed = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await withSecondFactor(work);
      changed(done);
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  let content: ReactNode;
  let dialog: ReactNode = null;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('tax.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { profile, taxGroups, series } = data.value;
    const groupsShown = shown(taxGroups, archived);
    const seriesShown = shown(series, archived);
    content = (
      <>
        <section className="settings-group" aria-labelledby="tax-legal">
          <div className="staff-header">
            <h3 id="tax-legal" className="settings-group__heading">
              {t('tax.legal.title')}
            </h3>
            {changes ? (
              <Button
                variant="secondary"
                aria-label={t('tax.legal.changeLabel')}
                onClick={() => {
                  setOpen({ kind: 'LEGAL' });
                }}
              >
                {t('tax.legal.change')}
              </Button>
            ) : null}
          </div>
          <p className="dashboard-section__hint">{t('tax.legal.intro')}</p>
          <LegalFacts profile={profile} />
        </section>
        <label className="console-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
            }}
          />
          {t('tax.showArchived')}
        </label>
        <section className="settings-group" aria-labelledby="tax-groups">
          <div className="staff-header">
            <h3 id="tax-groups" className="settings-group__heading">
              {t('tax.groups.title')}
            </h3>
            {changes ? (
              <Button
                startIcon={<Icon name="plus" />}
                onClick={() => {
                  setOpen({ kind: 'ADD_GROUP' });
                }}
              >
                {t('tax.groups.add')}
              </Button>
            ) : null}
          </div>
          <p className="dashboard-section__hint">{t('tax.groups.intro')}</p>
          {groupsShown.length === 0 ? (
            <EmptyState title={t('tax.groups.none')} />
          ) : (
            <ul className="staff-list">
              {groupsShown.map((group) => (
                <TaxGroupRow
                  key={group.id}
                  group={group}
                  changes={changes}
                  onEdit={() => {
                    setOpen({ kind: 'EDIT_GROUP', group });
                  }}
                  onArchive={() => {
                    setOpen({ kind: 'ARCHIVE_GROUP', group });
                  }}
                />
              ))}
            </ul>
          )}
        </section>
        <section className="settings-group" aria-labelledby="tax-series">
          <div className="staff-header">
            <h3 id="tax-series" className="settings-group__heading">
              {t('tax.series.title')}
            </h3>
            {changes ? (
              <Button
                variant="secondary"
                startIcon={<Icon name="plus" />}
                onClick={() => {
                  setOpen({ kind: 'ADD_SERIES' });
                }}
              >
                {t('tax.series.add')}
              </Button>
            ) : null}
          </div>
          <p className="dashboard-section__hint">{t('tax.series.intro')}</p>
          {seriesShown.length === 0 ? (
            <EmptyState title={t('tax.series.none')} />
          ) : (
            <ul className="staff-list">
              {seriesShown.map((entry) => (
                <SeriesRow
                  key={entry.id}
                  series={entry}
                  changes={changes}
                  onAction={(kind) => {
                    setOpen({ kind, series: entry });
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      </>
    );

    if (open?.kind === 'LEGAL') {
      dialog = (
        <LegalDialog
          profile={profile}
          withSecondFactor={withSecondFactor}
          onSaved={() => {
            changed(t('tax.legalDialog.saved'));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ADD_GROUP' || open?.kind === 'EDIT_GROUP') {
      dialog = (
        <TaxGroupDialog
          group={open.kind === 'EDIT_GROUP' ? open.group : undefined}
          groups={taxGroups}
          withSecondFactor={withSecondFactor}
          onSaved={(saved) => {
            changed(t('tax.groupDialog.saved', { name: saved.name }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ADD_SERIES' || open?.kind === 'EDIT_SERIES') {
      dialog = (
        <SeriesDialog
          series={open.kind === 'EDIT_SERIES' ? open.series : undefined}
          allSeries={series}
          today={calendarDateOf(new Date(), profile.timeZone)}
          withSecondFactor={withSecondFactor}
          onSaved={(saved) => {
            changed(t('tax.seriesDialog.saved', { name: saved.name }));
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_GROUP') {
      const { group } = open;
      dialog = (
        <ReasonDialog
          title={t('tax.archiveGroup.title', { name: group.name })}
          description={t('tax.archiveGroup.description')}
          label={t('tax.archiveGroup.reason')}
          confirmLabel={t('tax.archiveGroup.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void confirmed(
              () =>
                controller.api.archiveTaxGroup({
                  params: { taxGroupId: group.id },
                  body: { reason },
                }),
              t('tax.groups.archivedToast', { name: group.name }),
            );
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'ARCHIVE_SERIES') {
      const { series: entry } = open;
      dialog = (
        <ReasonDialog
          title={t('tax.archiveSeries.title', { name: entry.name })}
          description={t('tax.archiveSeries.description')}
          label={t('tax.archiveSeries.reason')}
          confirmLabel={t('tax.archiveSeries.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void confirmed(
              () =>
                controller.api.archiveInvoiceSeries({
                  params: { seriesId: entry.id },
                  body: { reason },
                }),
              t('tax.series.archivedToast', { name: entry.name }),
            );
          }}
          onClose={close}
        />
      );
    } else if (open?.kind === 'DEFAULT_SERIES') {
      const { series: entry } = open;
      dialog = (
        <ConfirmDialog
          open
          tone="primary"
          title={t('tax.defaultDialog.title', { name: entry.name })}
          description={t('tax.defaultDialog.description', {
            name: entry.name,
            example: entry.example,
          })}
          confirmLabel={t('tax.defaultDialog.confirm')}
          cancelLabel={t('settings.dialog.cancel')}
          busy={busy}
          onConfirm={() => {
            void confirmed(
              () => controller.api.setDefaultInvoiceSeries({ params: { seriesId: entry.id } }),
              t('tax.series.defaultToast', { name: entry.name }),
            );
          }}
          onCancel={close}
        >
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-tax">
      <h2 id="dashboard-tax" className="dashboard-section__heading">
        {t('tax.title')}
      </h2>
      <p className="dashboard-section__hint">{t('tax.intro')}</p>
      <p className="console-notice">{changes ? t('tax.secondFactor') : t('tax.ownerOnly')}</p>
      {content}
      {dialog}
      {secondFactorDialog}
    </section>
  );
}

/** The particulars as invoices print them, or that they are not given yet. */
function LegalFacts({ profile }: { profile: RestaurantProfile }) {
  const t = useT();
  const notGiven = t('tax.legal.notGiven');
  const { address } = profile;
  const addressText =
    address === null
      ? notGiven
      : [address.line1, address.line2, `${address.city} ${address.pincode}`]
          .filter((part) => part !== undefined)
          .join(', ');
  return (
    <dl className="settings-facts">
      <dt>{t('tax.legal.legalName')}</dt>
      <dd>{profile.legalName ?? notGiven}</dd>
      <dt>{t('tax.legal.address')}</dt>
      <dd>{addressText}</dd>
      <dt>{t('tax.legal.state')}</dt>
      <dd>
        {profile.stateCode === null
          ? notGiven
          : t('tax.legal.stateValue', { name: profile.stateName ?? '', code: profile.stateCode })}
      </dd>
      <dt>{t('tax.legal.gstin')}</dt>
      <dd>{profile.gstin ?? t('tax.legal.notRegistered')}</dd>
      <dt>{t('tax.legal.fssai')}</dt>
      <dd>{profile.fssaiNumber ?? notGiven}</dd>
    </dl>
  );
}

/** One tax group: its total rate, its taxes in print order, its SAC code and who uses it. */
function TaxGroupRow({
  group,
  changes,
  onEdit,
  onArchive,
}: {
  group: TaxGroupView;
  changes: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const t = useT();
  const isArchived = group.archivedAt !== null;
  const taxes =
    group.components.length === 0
      ? t('tax.groups.noTax')
      : group.components
          .map((component) =>
            t('tax.groups.component', { code: component.code, rate: percentOf(component.rateBp) }),
          )
          .join(' + ');
  return (
    <li className="staff-row" data-inactive={isArchived || undefined}>
      <div className="staff-row__who">
        <h4 className="staff-row__name">{group.name}</h4>
        <p className="settings-row__value">
          {t('settings.units.percent', { value: percentOf(group.totalRateBp) })}
        </p>
        <p className="staff-row__contact menu-facts">
          <span>{taxes}</span>
          {group.sacCode === null ? null : (
            <span>{t('tax.groups.sac', { code: group.sacCode })}</span>
          )}
        </p>
        <p className="staff-row__contact">{t('tax.groups.items', { count: group.itemCount })}</p>
        {isArchived ? (
          <p className="staff-row__states">
            <Badge tone="neutral">{t('tax.archived')}</Badge>
          </p>
        ) : null}
      </div>
      {changes && !isArchived ? (
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('tax.groups.actionsFor', { name: group.name })}
        >
          <Button variant="secondary" onClick={onEdit}>
            {t('tax.groups.edit')}
          </Button>
          <Button variant="secondary" onClick={onArchive}>
            {t('tax.groups.archive')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One invoice series: the first number of this financial year, whether it starts again every
 * April, how many invoices it has issued and whether new bills use it. The default series is not
 * archived; another one is made the default first.
 */
function SeriesRow({
  series,
  changes,
  onAction,
}: {
  series: InvoiceSeriesView;
  changes: boolean;
  onAction: (kind: 'EDIT_SERIES' | 'DEFAULT_SERIES' | 'ARCHIVE_SERIES') => void;
}) {
  const t = useT();
  const isArchived = series.archivedAt !== null;
  return (
    <li className="staff-row" data-inactive={isArchived || undefined}>
      <div className="staff-row__who">
        <h4 className="staff-row__name">{series.name}</h4>
        <p className="settings-row__value">
          {t('tax.series.firstNumber', { example: series.example })}
        </p>
        <p className="staff-row__contact menu-facts">
          <span>{t(series.includeFinancialYear ? 'tax.series.yearly' : 'tax.series.running')}</span>
          <span>{t('tax.series.invoices', { count: series.invoiceCount })}</span>
        </p>
        {series.isDefault || isArchived ? (
          <p className="staff-row__states">
            {series.isDefault ? <Badge tone="info">{t('tax.series.default')}</Badge> : null}
            {isArchived ? <Badge tone="neutral">{t('tax.archived')}</Badge> : null}
          </p>
        ) : null}
      </div>
      {changes && !isArchived ? (
        <div
          className="staff-row__actions"
          role="group"
          aria-label={t('tax.series.actionsFor', { name: series.name })}
        >
          <Button
            variant="secondary"
            onClick={() => {
              onAction('EDIT_SERIES');
            }}
          >
            {t('tax.series.edit')}
          </Button>
          {series.isDefault ? null : (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  onAction('DEFAULT_SERIES');
                }}
              >
                {t('tax.series.makeDefault')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  onAction('ARCHIVE_SERIES');
                }}
              >
                {t('tax.series.archive')}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}
