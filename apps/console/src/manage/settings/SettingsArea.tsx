import { Navigate, NavLink, Route, Routes } from 'react-router';
import { useT } from '../../app/i18n.js';
import { NotificationsScreen } from './NotificationsScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { SuggestionsScreen } from './SuggestionsScreen.js';

/**
 * The Settings area (P4-03, MGR-007) under `/manage/settings`, for the people who configure how
 * the restaurant runs: the settings from the catalogue (P4-03a), the notification rules (P4-03b)
 * and the suggestions (P4-03c), one page at a time. The server refuses anyone else's calls anyway.
 */
export function SettingsArea() {
  const t = useT();
  return (
    <>
      <nav aria-label={t('settings.pages.label')} className="staff-pages">
        <NavLink to="/manage/settings" end className="staff-pages__link">
          {t('settings.pages.general')}
        </NavLink>
        <NavLink to="/manage/settings/notifications" className="staff-pages__link">
          {t('settings.pages.notifications')}
        </NavLink>
        <NavLink to="/manage/settings/suggestions" className="staff-pages__link">
          {t('settings.pages.suggestions')}
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<SettingsScreen />} />
        <Route path="notifications" element={<NotificationsScreen />} />
        <Route path="suggestions" element={<SuggestionsScreen />} />
        <Route path="*" element={<Navigate to="/manage/settings" replace />} />
      </Routes>
    </>
  );
}
