import { Navigate, Route, Routes } from 'react-router';
import { SettingsScreen } from './SettingsScreen.js';

/**
 * The Settings area (P4-03, MGR-007) under `/manage/settings`, for the people who configure how
 * the restaurant runs: the settings from the catalogue (P4-03a). The server refuses anyone else's
 * calls anyway.
 */
export function SettingsArea() {
  return (
    <Routes>
      <Route index element={<SettingsScreen />} />
      <Route path="*" element={<Navigate to="/manage/settings" replace />} />
    </Routes>
  );
}
