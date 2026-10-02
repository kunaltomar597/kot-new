# apps/control-plane-web: the vendor web app (VCP-001)

The web app vendor staff use to run the fleet, on the Vendor Control Plane's API
(`apps/control-plane`). Built in P7-02e and P7-02f.

- **Stack:** React 19, React Router and Vite, with `@rp/ui-web`, `@rp/design-tokens` and the
  `vendorApp` strings in `@rp/i18n`.
- **API client:** typed from the contract registry (`CONTROL_PLANE_ROUTES` in
  `@rp/contracts/control-plane`, see `src/app/cp-api.ts`). Answers are checked against their
  schemas.
- **Served by the Control Plane:** set `CP_WEB_DIR` to this package's `dist`. The app and the API
  then share one origin, so there is no CORS, and strict security headers apply
  (`apps/control-plane/src/http/web-static.ts`).
- **Sign-in:** email, password and an authenticator code, always together (MFA is mandatory).
  - The session token is kept in the tab's session storage only. It is gone when the tab closes.
  - The Control Plane ends a session after 8 hours, or after 30 minutes without use. Any call it
    refuses with 401 brings the person back to signing in.
- **Account setup:** new accounts and resets come with a one-time link, `/setup#<token>`.
  - The token stays in the URL fragment, so it never reaches a server log.
  - The person chooses a password and adds an authenticator app (QR code or typed key), then
    proves it with a code.
- **Roles:** each section and button shows only when the role allows it. The capability matrix
  is `vendorMay` in `@rp/contracts/control-plane`. The server checks every call again, deny by
  default.

## What is where

| Folder            | What                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `src/app/`        | API client, session, services, i18n, data loading, formatting                                            |
| `src/components/` | Page frame, loading/error view, licence badge, one-time secret, reason dialog                            |
| `src/screens/`    | Sign-in, account setup, the layout with the role's sections                                              |
| `src/tenants/`    | Restaurants: the list, one restaurant (details, PCs, support notes, QR ordering), one PC and its licence |

## Commands

```
pnpm --filter @rp/control-plane-web dev     # Vite on :5173, API calls forwarded to CP_URL (default :8090)
pnpm --filter @rp/control-plane-web build   # dist/, for CP_WEB_DIR
pnpm --filter @rp/control-plane-web test    # UI tests per role against a fake Control Plane
```

The tests (`test/`) run the whole app in jsdom against `FakeControlPlane`. The fake matches
routes from the contract registry and refuses with 403 whatever the signed-in role may not do,
exactly as the real service does. A screen that calls something its role cannot use therefore
fails its test.
