import type { Translator } from '@rp/i18n';
import { LoadingState, ToastProvider } from '@rp/ui-web';
import { Navigate, Route, Routes } from 'react-router';
import { I18nProvider, useT } from './app/i18n.js';
import { type Services, ServicesProvider, useSession } from './app/services.js';
import { Layout, RequireCapability } from './screens/Layout.js';
import { SetupScreen } from './screens/SetupScreen.js';
import { SignInScreen } from './screens/SignInScreen.js';
import { InstallationScreen } from './tenants/InstallationScreen.js';
import { TenantScreen } from './tenants/TenantScreen.js';
import { TenantsScreen } from './tenants/TenantsScreen.js';

const HOME = '/restaurants';

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
          <Route
            path="/restaurants"
            element={
              <RequireCapability capability="FLEET_VIEW">
                <TenantsScreen />
              </RequireCapability>
            }
          />
          <Route
            path="/restaurants/:id"
            element={
              <RequireCapability capability="FLEET_VIEW">
                <TenantScreen />
              </RequireCapability>
            }
          />
          <Route
            path="/installations/:id"
            element={
              <RequireCapability capability="FLEET_VIEW">
                <InstallationScreen />
              </RequireCapability>
            }
          />
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
