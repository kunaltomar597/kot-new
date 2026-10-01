import type { InvoiceSeriesView, RestaurantProfile, TaxGroupView } from '@rp/contracts';
import { photoUrl } from '@rp/contracts';
import { businessDateOf } from '@rp/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useCallback, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { grantOf } from '../../app/modes.js';
import { useLive } from '../../app/use-live.js';
import { SecondFactorCancelled, useSecondFactor } from '../../owner/second-factor.js';
import { ReasonDialog } from '../menu/ReasonDialog.js';
import { bpText } from '../settings/settings-view.js';
import { LegalDialog, ProfileDialog, SeriesDialog, TaxGroupDialog } from './RestaurantDialogs.js';
import { componentsText, WEEKDAYS } from './restaurant-view.js';

type Translate = ReturnType<typeof useT>;

type Open =
  | { readonly kind: 'PROFILE' | 'LEGAL' | 'ADD_TAX' | 'ADD_SERIES' }
  | { readonly kind: 'EDIT_TAX' | 'ARCHIVE_TAX'; readonly group: TaxGroupView }
  | {
      readonly kind: 'EDIT_SERIES' | 'DEFAULT_SERIES' | 'ARCHIVE_SERIES';
      readonly series: InvoiceSeriesView;
    };

interface PageData {
  readonly profile: RestaurantProfile;
  readonly taxGroups: readonly TaxGroupView[];
  readonly series: readonly InvoiceSeriesView[];
  /** Today's business date, for the example invoice numbers. */
  readonly today: string;
}

function Facts({ facts }: { facts: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="restaurant-facts">
      {facts.map(([term, value]) => (
        <div key={term} className="restaurant-facts__row">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Monday: 11:00 to 15:00, 19:00 to 23:30" for each day, or "Closed". */
function hoursLines(profile: RestaurantProfile, t: Translate): ReactNode {
  return (
    <ul className="restaurant-facts__list">
      {WEEKDAYS.map((day) => {
        const windows = profile.businessHours
          .filter((window) => window.day === day)
          .map((window) =>
            t('restaurantPage.profile.window', { start: window.start, end: window.end }),
          );
        return (
          <li key={day}>
            {`${t(`restaurantPage.weekday.${day}`)}: ${
              windows.length === 0 ? t('restaurantPage.profile.closed') : windows.join(', ')
            }`}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The restaurant (P4-03e, ONB-004 steps 1 to 3, BILL-002 to BILL-004): its profile, which managers
 * keep up to date, and what the Owner alone changes with the second factor: the particulars on
 * every tax invoice, the tax groups with their rates, and the invoice series. Everything changed
 * here is audited on the server with the optional reason, and every screen follows.
 */
export function RestaurantScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const { withSecondFactor, dialog: secondFactorDialog } = useSecondFactor();
  const owner = person !== undefined && grantOf(person, 'TAX_AND_INVOICE_SETTINGS') !== 'DENY';
  const { data, reload } = useLive(
    async (): Promise<PageData> => {
      const [profile, taxGroups, series] = await Promise.all([
        controller.api.getRestaurant(),
        controller.api.listTaxGroups(),
        controller.api.listInvoiceSeries(),
      ]);
      return {
        profile,
        taxGroups: taxGroups.taxGroups.filter((group) => group.archivedAt === null),
        series: series.invoiceSeries.filter((entry) => entry.archivedAt === null),
        today: businessDateOf(new Date(), {
          cutoff: profile.businessDayCutoff,
          timeZone: profile.timeZone,
        }),
      };
    },
    (type) => type === 'RestaurantChanged',
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  /** Runs one change (asking the Owner's second factor when the server wants it). */
  const change = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await withSecondFactor(action);
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const ownerAction = (label: string, onClick: () => void, variant: 'secondary' | 'ghost') =>
    owner ? (
      <Button variant={variant} onClick={onClick}>
        {label}
      </Button>
    ) : null;

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('restaurantPage.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const { profile, taxGroups, series } = data.value;
    const notGiven = t('restaurantPage.profile.notGiven');
    content = (
      <>
        <section className="device-group" aria-labelledby="restaurant-profile">
          <div className="staff-header">
            <h3 id="restaurant-profile" className="device-group__heading">
              {t('restaurantPage.profile.title')}
            </h3>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen({ kind: 'PROFILE' });
              }}
            >
              {t('restaurantPage.change')}
            </Button>
          </div>
          <Facts
            facts={[
              [t('restaurantPage.profile.displayName'), profile.displayName],
              [t('restaurantPage.profile.phone'), profile.contact.phone ?? notGiven],
              [t('restaurantPage.profile.email'), profile.contact.email ?? notGiven],
              [t('restaurantPage.profile.hours'), hoursLines(profile, t)],
              [
                t('restaurantPage.profile.cutoff'),
                t('restaurantPage.profile.cutoffValue', { time: profile.businessDayCutoff }),
              ],
              [
                t('restaurantPage.profile.accent'),
                profile.accentColor === null ? (
                  t('restaurantPage.profile.accentStandard')
                ) : (
                  <span className="accent-swatch">
                    <span
                      className="accent-swatch__colour"
                      style={{ background: profile.accentColor }}
                      aria-hidden="true"
                    />
                    {profile.accentColor}
                  </span>
                ),
              ],
              [
                t('restaurantPage.profile.logo'),
                profile.logoPhotoId === null ? (
                  t('restaurantPage.profile.noLogo')
                ) : (
                  <img
                    className="menu-photo__preview"
                    src={photoUrl(profile.logoPhotoId, 160)}
                    alt={t('restaurantPage.profile.logoAlt')}
                    width={96}
                    height={96}
                  />
                ),
              ],
            ]}
          />
        </section>

        <section className="device-group" aria-labelledby="restaurant-legal">
          <div className="staff-header">
            <h3 id="restaurant-legal" className="device-group__heading">
              {t('restaurantPage.legal.title')}
            </h3>
            {ownerAction(
              t('restaurantPage.change'),
              () => {
                setOpen({ kind: 'LEGAL' });
              },
              'secondary',
            )}
          </div>
          <p className="dashboard-section__hint">
            {t('restaurantPage.legal.hint')}{' '}
            <Badge tone="warning">{t('restaurantPage.ownerOnly')}</Badge>
          </p>
          {owner ? null : <p className="dashboard-section__hint">{t('restaurantPage.notOwner')}</p>}
          {profile.legalName === null ? (
            <p className="console-notice">{t('restaurantPage.legal.notSet')}</p>
          ) : (
            <Facts
              facts={[
                [t('restaurantPage.legal.legalName'), profile.legalName],
                [
                  t('restaurantPage.legal.address'),
                  profile.address === null
                    ? notGiven
                    : [
                        profile.address.line1,
                        profile.address.line2,
                        `${profile.address.city} ${profile.address.pincode}`,
                      ]
                        .filter((line) => line !== undefined)
                        .join(', '),
                ],
                [t('restaurantPage.legal.state'), profile.stateName ?? notGiven],
                [
                  t('restaurantPage.legal.gstin'),
                  profile.gstin ?? t('restaurantPage.legal.noGstin'),
                ],
                [
                  t('restaurantPage.legal.fssai'),
                  profile.fssaiNumber ?? t('restaurantPage.legal.noFssai'),
                ],
              ]}
            />
          )}
        </section>

        <section className="device-group" aria-labelledby="restaurant-tax">
          <div className="staff-header">
            <h3 id="restaurant-tax" className="device-group__heading">
              {t('restaurantPage.taxGroups.title')}
            </h3>
            {ownerAction(
              t('restaurantPage.taxGroups.add'),
              () => {
                setOpen({ kind: 'ADD_TAX' });
              },
              'secondary',
            )}
          </div>
          <p className="dashboard-section__hint">{t('restaurantPage.taxGroups.hint')}</p>
          {taxGroups.length === 0 ? (
            <EmptyState title={t('restaurantPage.taxGroups.empty')} />
          ) : (
            <ul className="staff-list" aria-labelledby="restaurant-tax">
              {taxGroups.map((group) => (
                <li key={group.id} className="staff-row">
                  <div className="staff-row__who">
                    <h4 className="staff-row__name">{group.name}</h4>
                    <p className="staff-row__role">
                      {componentsText(group) ?? t('restaurantPage.taxGroups.noTax')}
                    </p>
                    <p className="staff-row__contact">
                      {[
                        t('restaurantPage.taxGroups.total', { rate: bpText(group.totalRateBp) }),
                        ...(group.sacCode === null
                          ? []
                          : [t('restaurantPage.taxGroups.sac', { code: group.sacCode })]),
                        t('restaurantPage.taxGroups.items', { count: group.itemCount }),
                      ].join(' · ')}
                    </p>
                  </div>
                  {owner ? (
                    <div
                      className="staff-row__actions"
                      role="group"
                      aria-label={t('restaurantPage.taxGroups.actionsFor', { name: group.name })}
                    >
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'EDIT_TAX', group });
                        }}
                      >
                        {t('restaurantPage.taxGroups.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setOpen({ kind: 'ARCHIVE_TAX', group });
                        }}
                      >
                        {t('restaurantPage.taxGroups.archive')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="device-group" aria-labelledby="restaurant-series">
          <div className="staff-header">
            <h3 id="restaurant-series" className="device-group__heading">
              {t('restaurantPage.series.title')}
            </h3>
            {ownerAction(
              t('restaurantPage.series.add'),
              () => {
                setOpen({ kind: 'ADD_SERIES' });
              },
              'secondary',
            )}
          </div>
          <p className="dashboard-section__hint">{t('restaurantPage.series.hint')}</p>
          {series.length === 0 ? (
            <EmptyState title={t('restaurantPage.series.empty')} />
          ) : (
            <ul className="staff-list" aria-labelledby="restaurant-series">
              {series.map((entry) => (
                <li key={entry.id} className="staff-row">
                  <div className="staff-row__who">
                    <h4 className="staff-row__name">{entry.name}</h4>
                    <p className="staff-row__role">
                      {t('restaurantPage.series.example', { example: entry.example })}
                    </p>
                    <p className="staff-row__contact">
                      {t('restaurantPage.series.invoices', { count: entry.invoiceCount })}
                    </p>
                    <p className="staff-row__states">
                      {entry.isDefault ? (
                        <Badge tone="success">{t('restaurantPage.series.default')}</Badge>
                      ) : null}
                      {entry.invoiceCount > 0 ? (
                        <Badge tone="neutral">{t('restaurantPage.series.fixed')}</Badge>
                      ) : null}
                    </p>
                  </div>
                  {owner ? (
                    <div
                      className="staff-row__actions"
                      role="group"
                      aria-label={t('restaurantPage.series.actionsFor', { name: entry.name })}
                    >
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'EDIT_SERIES', series: entry });
                        }}
                      >
                        {t('restaurantPage.series.edit')}
                      </Button>
                      {entry.isDefault ? null : (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setOpen({ kind: 'DEFAULT_SERIES', series: entry });
                            }}
                          >
                            {t('restaurantPage.series.makeDefault')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setOpen({ kind: 'ARCHIVE_SERIES', series: entry });
                            }}
                          >
                            {t('restaurantPage.series.archive')}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  }

  let dialog: ReactNode = null;
  if (open !== undefined && data.status === 'ready') {
    const { profile, today } = data.value;
    const state = { busy, error, onClose: close };
    switch (open.kind) {
      case 'PROFILE':
        dialog = (
          <ProfileDialog
            {...state}
            profile={profile}
            onSave={(body) => {
              void change(
                () => controller.api.updateRestaurantProfile({ body }),
                t('restaurantPage.profile.saved'),
              );
            }}
          />
        );
        break;
      case 'LEGAL':
        dialog = (
          <LegalDialog
            {...state}
            profile={profile}
            onSave={(body) => {
              void change(
                () => controller.api.updateRestaurantLegal({ body }),
                t('restaurantPage.legal.saved'),
              );
            }}
          />
        );
        break;
      case 'ADD_TAX':
      case 'EDIT_TAX': {
        const group = open.kind === 'EDIT_TAX' ? open.group : undefined;
        dialog = (
          <TaxGroupDialog
            {...state}
            group={group}
            onSave={(body) => {
              void change(
                () =>
                  group === undefined
                    ? controller.api.createTaxGroup({ body })
                    : controller.api.updateTaxGroup({ params: { taxGroupId: group.id }, body }),
                group === undefined
                  ? t('restaurantPage.taxGroups.added', { name: body.name })
                  : t('restaurantPage.taxGroups.saved', { name: body.name }),
              );
            }}
          />
        );
        break;
      }
      case 'ARCHIVE_TAX': {
        const { group } = open;
        dialog = (
          <ReasonDialog
            title={t('restaurantPage.taxGroups.archiveTitle', { name: group.name })}
            description={t('restaurantPage.taxGroups.archiveDescription')}
            confirmLabel={t('restaurantPage.taxGroups.archive')}
            hint={t('restaurantPage.reasonHint')}
            busy={busy}
            error={error}
            onConfirm={(reason) => {
              void change(
                () =>
                  controller.api.archiveTaxGroup({
                    params: { taxGroupId: group.id },
                    body: { reason },
                  }),
                t('restaurantPage.taxGroups.archived', { name: group.name }),
              );
            }}
            onCancel={close}
          />
        );
        break;
      }
      case 'ADD_SERIES':
      case 'EDIT_SERIES': {
        const series = open.kind === 'EDIT_SERIES' ? open.series : undefined;
        dialog = (
          <SeriesDialog
            {...state}
            series={series}
            today={today}
            onSave={(body) => {
              void change(
                () =>
                  series === undefined
                    ? controller.api.createInvoiceSeries({ body })
                    : controller.api.updateInvoiceSeries({
                        params: { seriesId: series.id },
                        body,
                      }),
                series === undefined
                  ? t('restaurantPage.series.added', { name: body.name })
                  : t('restaurantPage.series.saved', { name: body.name }),
              );
            }}
          />
        );
        break;
      }
      case 'DEFAULT_SERIES': {
        const { series } = open;
        dialog = (
          <ConfirmDialog
            open
            tone="primary"
            title={t('restaurantPage.series.defaultTitle', { name: series.name })}
            description={t('restaurantPage.series.defaultDescription')}
            confirmLabel={t('restaurantPage.series.makeDefault')}
            cancelLabel={t('restaurantPage.cancel')}
            busy={busy}
            onConfirm={() => {
              void change(
                () => controller.api.setDefaultInvoiceSeries({ params: { seriesId: series.id } }),
                t('restaurantPage.series.madeDefault', { name: series.name }),
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
        break;
      }
      case 'ARCHIVE_SERIES': {
        const { series } = open;
        dialog = (
          <ReasonDialog
            title={t('restaurantPage.series.archiveTitle', { name: series.name })}
            description={t('restaurantPage.series.archiveDescription')}
            confirmLabel={t('restaurantPage.series.archive')}
            hint={t('restaurantPage.reasonHint')}
            busy={busy}
            error={error}
            onConfirm={(reason) => {
              void change(
                () =>
                  controller.api.archiveInvoiceSeries({
                    params: { seriesId: series.id },
                    body: { reason },
                  }),
                t('restaurantPage.series.archived', { name: series.name }),
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
    <section className="dashboard-section" aria-labelledby="dashboard-restaurant">
      <h2 id="dashboard-restaurant" className="dashboard-section__heading">
        {t('restaurantPage.title')}
      </h2>
      <p className="dashboard-section__hint">{t('restaurantPage.intro')}</p>
      {content}
      {dialog}
      {secondFactorDialog}
    </section>
  );
}
