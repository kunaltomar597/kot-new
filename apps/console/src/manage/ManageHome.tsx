import type { MessageKey } from '@rp/i18n';
import type { ReactElement } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { AlertCentre } from '../alerts/AlertCentre.js';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { type ManagePage, manageLandingOf, managePagesFor } from '../app/modes.js';
import { OwnerSecurityScreen } from '../owner/OwnerSecurityScreen.js';
import { DevicesScreen } from './devices/DevicesScreen.js';
import { MenuArea } from './menu/MenuArea.js';
import { OrderFeedScreen } from './OrderFeedScreen.js';
import { Overview } from './Overview.js';
import { SettingsArea } from './settings/SettingsArea.js';
import { StaffArea } from './staff/StaffArea.js';

/** Each page's address under `/manage`, its link text and what it shows. */
const PAGES: Readonly<
  Record<
    ManagePage,
    { readonly path: string; readonly label: MessageKey; readonly element: ReactElement }
  >
> = {
  overview: { path: '', label: 'dashboard.section.overview', element: <Overview /> },
  orders: { path: 'orders', label: 'dashboard.section.orders', element: <OrderFeedScreen /> },
  alerts: { path: 'alerts', label: 'dashboard.section.alerts', element: <AlertsSection /> },
  menu: { path: 'menu', label: 'dashboard.section.menu', element: <MenuArea /> },
  staff: { path: 'staff', label: 'dashboard.section.staff', element: <StaffArea /> },
  devices: { path: 'devices', label: 'dashboard.section.devices', element: <DevicesScreen /> },
  settings: { path: 'settings', label: 'dashboard.section.settings', element: <SettingsArea /> },
  security: {
    path: 'security',
    label: 'dashboard.section.security',
    element: <OwnerSecurityScreen />,
  },
};

/** Pages with pages of their own below them. */
const NESTED: ReadonlySet<ManagePage> = new Set(['menu', 'staff', 'settings']);

/**
 * The manager dashboard (P4-01, MGR-001): the overview, the live order feed and the alert centre,
 * one at a time under `/manage`, then the setup pages: the menu editor for people who manage the
 * menu (P4-02d, MGR-005), Staff for people who manage staff (people, today's sections, pagers and
 * custom roles; P4-02a, P4-02b, P4-02e, MGR-004), Devices for people who pair them (P4-02c,
 * MGR-006), Settings for people who configure operations (P4-03, MGR-007) and the Owner's own
 * sign-in security (AUTH-006). The navigation sits beside them on a wide screen and above them on
 * a phone (MGR-011); the page shown is marked for screen readers, not by colour alone. Pages a
 * person cannot use, their custom role applied (AUTH-012), are neither linked nor opened; the
 * server refuses their calls anyway.
 */
export function ManageHome() {
  const t = useT();
  const { person } = useConsoleState();
  if (person === undefined) return null;
  const pages = managePagesFor(person);
  const landing = manageLandingOf(pages);
  return (
    <div className="dashboard">
      <nav aria-label={t('dashboard.navigation')} className="dashboard__nav">
        {pages.map((page) => (
          <NavLink
            key={page}
            to={PAGES[page].path === '' ? '/manage' : `/manage/${PAGES[page].path}`}
            end={PAGES[page].path === ''}
            className="dashboard__link"
          >
            {t(PAGES[page].label)}
          </NavLink>
        ))}
      </nav>
      <div className="dashboard__content">
        <Routes>
          {landing === 'overview' ? null : (
            <Route index element={<Navigate to={`/manage/${PAGES[landing].path}`} replace />} />
          )}
          {pages.map((page) =>
            PAGES[page].path === '' ? (
              <Route key={page} index element={PAGES[page].element} />
            ) : (
              <Route
                key={page}
                path={NESTED.has(page) ? `${PAGES[page].path}/*` : PAGES[page].path}
                element={PAGES[page].element}
              />
            ),
          )}
          <Route path="*" element={<Navigate to="/manage" replace />} />
        </Routes>
      </div>
    </div>
  );
}

/** The alert centre (P2-06c, MGR-008) as a dashboard page. */
function AlertsSection() {
  const t = useT();
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-alerts">
      <h2 id="dashboard-alerts" className="dashboard-section__heading">
        {t('alerts.title')}
      </h2>
      <AlertCentre />
    </section>
  );
}
