import { grantOf } from '@rp/domain';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { useConsoleState } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { PagersScreen } from './PagersScreen.js';
import { RoleEditor } from './RoleEditor.js';
import { RolesScreen } from './RolesScreen.js';
import { SectionsScreen } from './SectionsScreen.js';
import { StaffScreen } from './StaffScreen.js';

/**
 * The Staff area (MGR-004): the people (P4-02a), today's sections and the pagers (P4-02b) and the
 * custom roles (P4-02e, AUTH-012), one at a time under `/manage/staff`. Pagers are shown only to
 * people who may pair devices (PGR-012); the role editor only to the Owner, who alone changes
 * roles. The server refuses their calls anyway.
 */
export function StaffArea() {
  const t = useT();
  const { person } = useConsoleState();
  const pairsDevices = person !== undefined && grantOf(person, 'DEVICE_PAIR') === 'ALLOW';
  const isOwner = person?.role === 'OWNER';
  return (
    <>
      <nav aria-label={t('staff.pages.label')} className="staff-pages">
        <NavLink to="/manage/staff" end className="staff-pages__link">
          {t('staff.pages.people')}
        </NavLink>
        <NavLink to="/manage/staff/sections" className="staff-pages__link">
          {t('staff.pages.sections')}
        </NavLink>
        {pairsDevices ? (
          <NavLink to="/manage/staff/pagers" className="staff-pages__link">
            {t('staff.pages.pagers')}
          </NavLink>
        ) : null}
        <NavLink to="/manage/staff/roles" className="staff-pages__link">
          {t('staff.pages.roles')}
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<StaffScreen />} />
        <Route path="sections" element={<SectionsScreen />} />
        {pairsDevices ? <Route path="pagers" element={<PagersScreen />} /> : null}
        <Route path="roles" element={<RolesScreen />} />
        {isOwner ? <Route path="roles/new" element={<RoleEditor />} /> : null}
        {isOwner ? <Route path="roles/:roleId" element={<RoleEditor />} /> : null}
        <Route path="*" element={<Navigate to="/manage/staff" replace />} />
      </Routes>
    </>
  );
}
