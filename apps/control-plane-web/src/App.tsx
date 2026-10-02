import type { Translator } from '@rp/i18n';
import { LoadingState, ToastProvider } from '@rp/ui-web';
import type { VendorCapability } from '@rp/contracts/control-plane';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { I18nProvider, useT } from './app/i18n.js';
import { AuditScreen } from './audit/AuditScreen.js';
import { InvoicesScreen } from './billing/InvoicesScreen.js';
import { PlansScreen } from './billing/PlansScreen.js';
import { ReleasesScreen } from './releases/ReleasesScreen.js';
import { RemoteSettingsScreen } from './remote/RemoteSettingsScreen.js';
import { FleetScreen } from './fleet/FleetScreen.js';
import { StaffScreen } from './staff/StaffScreen.js';
import { type Services, ServicesProvider, useSession } from './app/services.js';
import { Layout, RequireCapability } from './screens/Layout.js';
import { SetupScreen } from './screens/SetupScreen.js';
import { SignInScreen } from './screens/SignInScreen.js';
import { InstallationScreen } from './tenants/InstallationScreen.js';
import { TenantScreen } from './tenants/TenantScreen.js';
import { TenantsScreen } from './tenants/TenantsScreen.js';

const HOME = '/restaurants';

/** The signed-in pages and the capability each needs (the server checks every call again). */
const PAGES: readonly { path: string; capability: VendorCapability; element: ReactNode }[] = [
  { path: '/restaurants', capability: 'FLEET_VIEW', element: <TenantsScreen /> },
  { path: '/restaurants/:id', capability: 'FLEET_VIEW', element: <TenantScreen /> },
  { path: '/installations/:id', capability: 'FLEET_VIEW', element: <InstallationScreen /> },
  { path: '/fleet', capability: 'FLEET_VIEW', element: <FleetScreen /> },
  { path: '/invoices', capability: 'FLEET_VIEW', element: <InvoicesScreen /> },
  { path: '/plans', capability: 'FLEET_VIEW', element: <PlansScreen /> },
  { path: '/releases', capability: 'FLEET_VIEW', element: <ReleasesScreen /> },
  { path: '/remote-settings', capability: 'FLEET_VIEW', element: <RemoteSettingsScreen /> },
  { path: '/audit', capability: 'AUDIT_VIEW', element: <AuditScreen /> },
  { path: '/staff', capability: 'USERS_MANAGE', element: <StaffScreen /> },
];

export function AppRoutes() {
  const t = useT();
  const session = useSession();
  if (session.status === 'loading') {
    return (
      <main className="cp-center">
        <LoadingState title={t('states.loading')} />
      </main>
    );
  }
  const signedIn = session.status === 'signedIn';
  return (
    <Routes>
      <Route path="/setup" element={<SetupScreen />} />
      <Route
        path="/sign-in"
        element={signedIn ? <Navigate to={HOME} replace /> : <SignInScreen />}
      />
      {signedIn ? (
        <Route element={<Layout />}>
          {PAGES.map((page) => (
            <Route
              key={page.path}
              path={page.path}
              element={
                <RequireCapability capability={page.capability}>{page.element}</RequireCapability>
              }
            />
          ))}
        </Route>
      ) : null}
      <Route path="*" element={<Navigate to={signedIn ? HOME : '/sign-in'} replace />} />
    </Routes>
  );
}

/** The web app for vendor staff (VCP-001), on the Control Plane's API. */
export function App({ services, translator }: { services: Services; translator: Translator }) {
  return (
    <I18nProvider translator={translator}>
      <ServicesProvider services={services}>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </ServicesProvider>
    </I18nProvider>
  );
}
