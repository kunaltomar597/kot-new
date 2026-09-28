import { grantFor } from '@rp/domain';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { AlertCentre } from '../alerts/AlertCentre.js';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { OwnerSecurityScreen } from '../owner/OwnerSecurityScreen.js';
import { OrderFeedScreen } from './OrderFeedScreen.js';
import { Overview } from './Overview.js';
import { StaffArea } from './staff/StaffArea.js';

/**
 * The manager dashboard (P4-01, MGR-001): the overview, the live order feed and the alert centre,
 * one at a time under `/manage`, then the setup pages: Staff for people who manage staff (people,
 * today's sections and pagers; P4-02a, P4-02b, MGR-004) and the Owner's own sign-in security
 * (AUTH-006). The navigation sits beside them on a wide screen and above them on a phone
 * (MGR-011); the page shown is marked for screen readers, not by colour alone. Pages a role cannot
 * use are neither linked nor opened; the server refuses their calls anyway.
 */
export function ManageHome() {
  const t = useT();
  const { person } = useConsoleState();
  const managesStaff = person !== undefined && grantFor(person.role, 'STAFF_MANAGE') === 'ALLOW';
  const isOwner = person?.role === 'OWNER';
  return (
    <div className="dashboard">
      <nav aria-label={t('dashboard.navigation')} className="dashboard__nav">
        <NavLink to="/manage" end className="dashboard__link">
          {t('dashboard.section.overview')}
        </NavLink>
        <NavLink to="/manage/orders" className="dashboard__link">
          {t('dashboard.section.orders')}
        </NavLink>
        <NavLink to="/manage/alerts" className="dashboard__link">
          {t('dashboard.section.alerts')}
        </NavLink>
        {managesStaff ? (
          <NavLink to="/manage/staff" className="dashboard__link">
            {t('dashboard.section.staff')}
          </NavLink>
        ) : null}
        {isOwner ? (
          <NavLink to="/manage/security" className="dashboard__link">
            {t('dashboard.section.security')}
          </NavLink>
        ) : null}
      </nav>
      <div className="dashboard__content">
        <Routes>
          <Route index element={<Overview />} />
          <Route path="orders" element={<OrderFeedScreen />} />
          <Route path="alerts" element={<AlertsSection />} />
          {managesStaff ? <Route path="staff/*" element={<StaffArea />} /> : null}
          {isOwner ? <Route path="security" element={<OwnerSecurityScreen />} /> : null}
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
