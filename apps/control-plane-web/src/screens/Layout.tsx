import type { VendorCapability } from '@rp/contracts/control-plane';
import { Badge, Button } from '@rp/ui-web';
import type { MessageKey } from '@rp/i18n';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useT } from '../app/i18n.js';
import { useApi, useMay, useSession, useSessionStore } from '../app/services.js';

/** The app's sections and the capability each needs to appear (the server checks again). */
export const NAV: readonly {
  readonly path: string;
  readonly label: MessageKey;
  readonly capability: VendorCapability;
}[] = [
  { path: '/restaurants', label: 'vendorApp.nav.restaurants', capability: 'FLEET_VIEW' },
  { path: '/invoices', label: 'vendorApp.nav.invoices', capability: 'FLEET_VIEW' },
  { path: '/plans', label: 'vendorApp.nav.plans', capability: 'FLEET_VIEW' },
  { path: '/releases', label: 'vendorApp.nav.releases', capability: 'FLEET_VIEW' },
  { path: '/audit', label: 'vendorApp.nav.audit', capability: 'AUDIT_VIEW' },
  { path: '/staff', label: 'vendorApp.nav.staff', capability: 'USERS_MANAGE' },
];

/** Header with the sections this role may open, who is signed in, and signing out. */
export function Layout() {
  const t = useT();
  const api = useApi();
  const store = useSessionStore();
  const session = useSession();
  const may = useMay();
  const [leaving, setLeaving] = useState(false);
  if (session.status !== 'signedIn') return null;
  const { user } = session.me;
  return (
    <div className="cp-shell">
      <header className="cp-topbar">
        <span className="cp-topbar__name">{t('vendorApp.name')}</span>
        <nav aria-label={t('vendorApp.nav.label')} className="cp-nav">
          {NAV.filter((item) => may(item.capability)).map((item) => (
            <NavLink key={item.path} to={item.path} className="cp-nav__link">
              {t(item.label)}
            </NavLink>
          ))}
        </nav>
        <div className="cp-topbar__who">
          <span>{user.name}</span>
          <Badge tone="neutral">{t(`vendorApp.roles.${user.role}`)}</Badge>
          <Button
            variant="ghost"
            loading={leaving}
            onClick={() => {
              setLeaving(true);
              api
                .vendorSignOut()
                .catch(() => undefined)
                .finally(() => {
                  store.cleared(false);
                });
            }}
          >
            {t('vendorApp.signOut')}
          </Button>
        </div>
      </header>
      <main className="cp-main">
        <Outlet />
      </main>
    </div>
  );
}

/** A page the role does not allow: said plainly, never a blank screen. */
export function RequireCapability({
  capability,
  children,
}: {
  capability: VendorCapability;
  children: React.ReactNode;
}) {
  const t = useT();
  const may = useMay();
  if (may(capability)) return <>{children}</>;
  return <p className="cp-notice cp-notice--warning">{t('vendorApp.errors.notAllowedPage')}</p>;
}
