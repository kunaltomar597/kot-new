import { grantOf } from '@rp/domain';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { FloorScreen } from './FloorScreen.js';
import { NotificationsScreen } from './NotificationsScreen.js';
import { PrintingScreen } from './PrintingScreen.js';
import { RestaurantScreen } from './RestaurantScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { SuggestionsScreen } from './SuggestionsScreen.js';
import { TaxScreen } from './TaxScreen.js';

/**
 * The Settings area (P4-03, MGR-007) under `/manage/settings`, for the people who configure how
 * the restaurant runs: the settings from the catalogue (P4-03a), the restaurant's profile and its
 * tax and invoice settings (P4-03e), the notification rules (P4-03b), the suggestions (P4-03c),
 * the floor and the stations and printers (P4-03d), one page at a time. The floor is shown only to
 * people who may also manage staff and sections (BRD §4.2), as the server allows; tax and invoice
 * settings are shown to all of them and changed by the Owner only. The server refuses anyone
 * else's calls anyway.
 */
export function SettingsArea() {
  const t = useT();
  const { person } = useConsoleState();
  const changesFloor = person !== undefined && grantOf(person, 'STAFF_MANAGE') === 'ALLOW';
  return (
    <>
      <nav aria-label={t('settings.pages.label')} className="staff-pages">
        <NavLink to="/manage/settings" end className="staff-pages__link">
          {t('settings.pages.general')}
        </NavLink>
        <NavLink to="/manage/settings/restaurant" className="staff-pages__link">
          {t('settings.pages.restaurant')}
        </NavLink>
        <NavLink to="/manage/settings/tax" className="staff-pages__link">
          {t('settings.pages.tax')}
        </NavLink>
        <NavLink to="/manage/settings/notifications" className="staff-pages__link">
          {t('settings.pages.notifications')}
        </NavLink>
        <NavLink to="/manage/settings/suggestions" className="staff-pages__link">
          {t('settings.pages.suggestions')}
        </NavLink>
        {changesFloor ? (
          <NavLink to="/manage/settings/floor" className="staff-pages__link">
            {t('settings.pages.floor')}
          </NavLink>
        ) : null}
        <NavLink to="/manage/settings/printing" className="staff-pages__link">
          {t('settings.pages.printing')}
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<SettingsScreen />} />
        <Route path="restaurant" element={<RestaurantScreen />} />
        <Route path="tax" element={<TaxScreen />} />
        <Route path="notifications" element={<NotificationsScreen />} />
        <Route path="suggestions" element={<SuggestionsScreen />} />
        {changesFloor ? <Route path="floor" element={<FloorScreen />} /> : null}
        <Route path="printing" element={<PrintingScreen />} />
        <Route path="*" element={<Navigate to="/manage/settings" replace />} />
      </Routes>
    </>
  );
}
