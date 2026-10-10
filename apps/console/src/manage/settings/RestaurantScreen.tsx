import type { RestaurantProfile } from '@rp/contracts';
import { grantOf } from '@rp/domain';
import { Button, ErrorState, LoadingState, useToast } from '@rp/ui-web';
import { Fragment, type ReactNode, useState } from 'react';
import { useConsole, useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { ContactDialog, CutoffDialog, HoursDialog } from './RestaurantDialogs.js';
import { hoursFormOf, isOvernight, WEEKDAYS } from './restaurant-view.js';

type Open = 'CONTACT' | 'HOURS' | 'CUTOFF';

/**
 * The Restaurant page (P4-03e, ONB-004 step 1, MGR-007): the name guests and staff see, the phone
 * and email printed on bills, the logo, the opening hours and when the business day ends, each
 * part changed in its own dialog by the people who configure operations. The server audits every
 * change and announces it (`RestaurantChanged`), and the page follows changes made elsewhere. The
 * invoice particulars are the Owner's, on the Tax and invoice page.
 */
export function RestaurantScreen() {
  const t = useT();
  const controller = useConsole();
  const { person } = useConsoleState();
  const toast = useToast();
  const { data, reload } = useLive(
    () => controller.api.getRestaurant(),
    (type) => type === 'RestaurantChanged',
  );
  const [open, setOpen] = useState<Open | undefined>();
  // Logos go to the photo store, whose uploads need permission to manage the menu.
  const uploadsLogo = person !== undefined && grantOf(person, 'MENU_MANAGE') === 'ALLOW';

  const close = () => {
    setOpen(undefined);
  };
  const saved = (title: string) => {
    toast.show({ title, tone: 'success' });
    close();
    reload();
  };

  let content: ReactNode;
  let dialog: ReactNode = null;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('restaurant.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const profile = data.value;
    content = (
      <>
        <Part
          id="restaurant-contact"
          title={t('restaurant.contact.title')}
          changeLabel={t('restaurant.contact.changeLabel')}
          onChange={() => {
            setOpen('CONTACT');
          }}
        >
          <ContactFacts profile={profile} />
        </Part>
        <Part
          id="restaurant-hours"
          title={t('restaurant.hours.title')}
          intro={t('restaurant.hours.intro')}
          changeLabel={t('restaurant.hours.changeLabel')}
          onChange={() => {
            setOpen('HOURS');
          }}
        >
          <HoursFacts profile={profile} />
        </Part>
        <Part
          id="restaurant-business-day"
          title={t('restaurant.businessDay.title')}
          intro={t('restaurant.businessDay.intro')}
          changeLabel={t('restaurant.businessDay.changeLabel')}
          onChange={() => {
            setOpen('CUTOFF');
          }}
        >
          <dl className="settings-facts">
            <dt>{t('restaurant.businessDay.endsAt')}</dt>
            <dd>{profile.businessDayCutoff}</dd>
          </dl>
        </Part>
      </>
    );
    if (open === 'CONTACT') {
      dialog = (
        <ContactDialog
          profile={profile}
          uploadsLogo={uploadsLogo}
          onSaved={() => {
            saved(t('restaurant.contactDialog.saved'));
          }}
          onClose={close}
        />
      );
    } else if (open === 'HOURS') {
      dialog = (
        <HoursDialog
          profile={profile}
          onSaved={() => {
            saved(t('restaurant.hoursDialog.saved'));
          }}
          onClose={close}
        />
      );
    } else if (open === 'CUTOFF') {
      dialog = (
        <CutoffDialog
          profile={profile}
          onSaved={(changed) => {
            saved(t('restaurant.cutoffDialog.saved', { time: changed.businessDayCutoff }));
          }}
          onClose={close}
        />
      );
    }
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-restaurant">
      <h2 id="dashboard-restaurant" className="dashboard-section__heading">
        {t('restaurant.title')}
      </h2>
      <p className="dashboard-section__hint">{t('restaurant.intro')}</p>
      {content}
      {dialog}
    </section>
  );
}

/** One part of the profile: its heading, what it is for, a Change button and what is saved. */
function Part({
  id,
  title,
  intro,
  changeLabel,
  onChange,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  changeLabel: string;
  onChange: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="settings-group" aria-labelledby={id}>
      <div className="staff-header">
        <h3 id={id} className="settings-group__heading">
          {title}
        </h3>
        <Button variant="secondary" aria-label={changeLabel} onClick={onChange}>
          {t('restaurant.change')}
        </Button>
      </div>
      {intro === undefined ? null : <p className="dashboard-section__hint">{intro}</p>}
      {children}
    </section>
  );
}

function ContactFacts({ profile }: { profile: RestaurantProfile }) {
  const t = useT();
  const controller = useConsole();
  const notGiven = t('restaurant.notGiven');
  return (
    <dl className="settings-facts">
      <dt>{t('restaurant.contact.name')}</dt>
      <dd>{profile.displayName}</dd>
      <dt>{t('restaurant.contact.phone')}</dt>
      <dd>{profile.contact.phone ?? notGiven}</dd>
      <dt>{t('restaurant.contact.email')}</dt>
      <dd>{profile.contact.email ?? notGiven}</dd>
      <dt>{t('restaurant.contact.logo')}</dt>
      <dd>
        {profile.logoPhotoId === null ? (
          t('restaurant.contact.noLogo')
        ) : (
          <img
            className="settings-logo"
            src={controller.photoSrc(profile.logoPhotoId, 480)}
            alt={t('restaurant.contact.logoAlt', { name: profile.displayName })}
          />
        )}
      </dd>
    </dl>
  );
}

/** Each day's hours in restaurant time, or that it is closed. */
function HoursFacts({ profile }: { profile: RestaurantProfile }) {
  const t = useT();
  const week = hoursFormOf(profile.businessHours);
  return (
    <dl className="settings-facts">
      {WEEKDAYS.map((day) => (
        <Fragment key={day}>
          <dt>{t(`restaurant.days.${day}`)}</dt>
          <dd>
            {week[day].length === 0
              ? t('restaurant.hours.closed')
              : week[day]
                  .map((window) =>
                    t(
                      isOvernight(window)
                        ? 'restaurant.hours.windowOvernight'
                        : 'restaurant.hours.window',
                      { start: window.start, end: window.end },
                    ),
                  )
                  .join(', ')}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
