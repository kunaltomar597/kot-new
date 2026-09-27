import { Navigate, NavLink, Route, Routes } from 'react-router';
import { AlertCentre } from '../alerts/AlertCentre.js';
import { useT } from '../app/i18n.js';
import { OrderFeedScreen } from './OrderFeedScreen.js';
import { Overview } from './Overview.js';

/**
 * The manager dashboard (P4-01, MGR-001): the overview, the live order feed and the alert centre,
 * one at a time under `/manage`. The navigation sits beside them on a wide screen and above them
 * on a phone (MGR-011); the page shown is marked for screen readers, not by colour alone.
 */
export function ManageHome() {
  const t = useT();
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
      </nav>
      <div className="dashboard__content">
        <Routes>
          <Route index element={<Overview />} />
          <Route path="orders" element={<OrderFeedScreen />} />
          <Route path="alerts" element={<AlertsSection />} />
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
