import type { Capability } from '@rp/domain';
import { grantOf } from '../app/modes.js';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { AlertCentre } from '../alerts/AlertCentre.js';
import { useConsoleState } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { OwnerSecurityScreen } from '../owner/OwnerSecurityScreen.js';
import { DevicesScreen } from './devices/DevicesScreen.js';
import { MenuEditor } from './menu/MenuEditor.js';
import { PrintingScreen } from './printing/PrintingScreen.js';
import { AuditScreen } from './audit/AuditScreen.js';
import { ReportsArea } from './reports/ReportsArea.js';
import { RestaurantScreen } from './restaurant/RestaurantScreen.js';
import { NotificationRulesScreen } from './settings/NotificationRulesScreen.js';
import { RecommendationsScreen } from './settings/RecommendationsScreen.js';
import { SettingsScreen } from './settings/SettingsScreen.js';
import { OrderFeedScreen } from './OrderFeedScreen.js';
import { Overview } from './Overview.js';
import { StaffArea } from './staff/StaffArea.js';
import { SystemScreen } from './system/SystemScreen.js';

/**
 * The manager dashboard (P4-01, MGR-001): the overview, the live order feed and the alert centre,
 * one at a time under `/manage`, then the setup pages: Staff for people who manage staff (people,
 * today's sections and pagers; P4-02a, P4-02b, MGR-004), the menu editor (P4-02d, MGR-005), Devices for people
 * who pair them (P4-02c, MGR-006), the restaurant's profile, tax groups and invoice series
 * (P4-03e, ONB-004), the reports (P4-05d, RPT-016), the kitchen stations and printers (P4-03d,
 * KDS-008), the
 * settings with their own pages (P4-03a to P4-03c, MGR-007), the System page (P4-04, MGR-010)
 * and the Owner's own sign-in security
 * (AUTH-006). The navigation sits beside them on a wide screen and above them on a phone
 * (MGR-011); the page shown is marked for screen readers, not by colour alone. Pages a role cannot
 * use are neither linked nor opened; the server refuses their calls anyway.
 */
export function ManageHome() {
  const t = useT();
  const { person } = useConsoleState();
  const allows = (capability: Capability) =>
    person !== undefined && grantOf(person, capability) === 'ALLOW';
  // The overview, order feed and alerts are the managers' view of service (OPERATIONS_CONFIGURE);
  // a custom role that only adds, say, the menu opens straight on its own page (AUTH-012).
  const operates = allows('OPERATIONS_CONFIGURE');
  const managesStaff = allows('STAFF_MANAGE');
  const pairsDevices = allows('DEVICE_PAIR');
  const managesMenu = allows('MENU_MANAGE');
  const seesReports = allows('REPORTS_VIEW_EXPORT');
  const viewsAudit = allows('AUDIT_VIEW');
  const isOwner = person?.role === 'OWNER';
  const first = operates
    ? undefined
    : seesReports
      ? 'reports'
      : managesMenu
        ? 'menu'
        : managesStaff
          ? 'staff'
          : pairsDevices
            ? 'devices'
            : undefined;
  return (
    <div className="dashboard">
      <nav aria-label={t('dashboard.navigation')} className="dashboard__nav">
        {operates ? (
          <>
            <NavLink to="/manage" end className="dashboard__link">
              {t('dashboard.section.overview')}
            </NavLink>
            <NavLink to="/manage/orders" className="dashboard__link">
              {t('dashboard.section.orders')}
            </NavLink>
            <NavLink to="/manage/alerts" className="dashboard__link">
              {t('dashboard.section.alerts')}
            </NavLink>
          </>
        ) : null}
        {seesReports ? (
          <NavLink to="/manage/reports" className="dashboard__link">
            {t('dashboard.section.reports')}
          </NavLink>
        ) : null}
        {viewsAudit ? (
          <NavLink to="/manage/audit" className="dashboard__link">
            {t('dashboard.section.audit')}
          </NavLink>
        ) : null}
        {managesStaff ? (
          <NavLink to="/manage/staff" className="dashboard__link">
            {t('dashboard.section.staff')}
          </NavLink>
        ) : null}
        {managesMenu ? (
          <NavLink to="/manage/menu" className="dashboard__link">
            {t('dashboard.section.menu')}
          </NavLink>
        ) : null}
        {pairsDevices ? (
          <NavLink to="/manage/devices" className="dashboard__link">
            {t('dashboard.section.devices')}
          </NavLink>
        ) : null}
        {operates ? (
          <NavLink to="/manage/restaurant" className="dashboard__link">
            {t('dashboard.section.restaurant')}
          </NavLink>
        ) : null}
        {operates ? (
          <NavLink to="/manage/printing" className="dashboard__link">
            {t('dashboard.section.printing')}
          </NavLink>
        ) : null}
        {operates ? (
          <NavLink to="/manage/settings" className="dashboard__link">
            {t('dashboard.section.settings')}
          </NavLink>
        ) : null}
        {operates ? (
          <NavLink to="/manage/system" className="dashboard__link">
            {t('dashboard.section.system')}
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
          {operates ? (
            <>
              <Route index element={<Overview />} />
              <Route path="orders" element={<OrderFeedScreen />} />
              <Route path="alerts" element={<AlertsSection />} />
            </>
          ) : first === undefined ? null : (
            <Route index element={<Navigate to={`/manage/${first}`} replace />} />
          )}
          {seesReports ? <Route path="reports/*" element={<ReportsArea />} /> : null}
          {viewsAudit ? <Route path="audit" element={<AuditScreen />} /> : null}
          {managesStaff ? <Route path="staff/*" element={<StaffArea />} /> : null}
          {managesMenu ? <Route path="menu" element={<MenuEditor />} /> : null}
          {pairsDevices ? <Route path="devices" element={<DevicesScreen />} /> : null}
          {operates ? <Route path="restaurant" element={<RestaurantScreen />} /> : null}
          {operates ? <Route path="printing" element={<PrintingScreen />} /> : null}
          {operates ? <Route path="settings" element={<SettingsScreen />} /> : null}
          {operates ? <Route path="system" element={<SystemScreen />} /> : null}
          {operates ? (
            <Route path="settings/notifications" element={<NotificationRulesScreen />} />
          ) : null}
          {operates ? (
            <Route path="settings/recommendations" element={<RecommendationsScreen />} />
          ) : null}
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
