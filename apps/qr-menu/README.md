# apps/qr-menu: QR online menu (C7)

The public, mobile-first site a table's QR code opens (`/t/<token>`, P5-04). No app and no login.
It shows the table's menu from the QR relay and sends dine-in orders through the relay's
functions; it never writes a database (QR-006). Built by P5-05a (P5-05b adds recommendations,
call waiter / request bill and the Lighthouse budget).

- Next.js 16 App Router.
  - `src/app/t/[token]/page.tsx` fetches the menu on the server, so the first view is already
    the menu (QR-012).
  - `src/site/QrMenu.tsx` does the rest in the browser, talking to the relay directly: search
    and filters, dishes with their options, the cart, sending, and following each order.
  - The page is read-only with a banner while the restaurant is absent (QR-008).
- Shared logic is the same as on every surface (MENU-012): the selection rules from `@rp/domain`,
  and search, filters, cart and estimate from `@rp/ordering`. Components come from `@rp/ui-web`
  and words from `@rp/i18n` (`qrSite.*`).
- Privacy (QR-013):
  - no third-party scripts, fonts, images or trackers;
  - `Referrer-Policy: no-referrer`, because the address holds the table's code;
  - a Content-Security-Policy that allows only this site and the relay, set per request in
    `src/proxy.ts`, with a nonce of its own for Next.js's scripts and no inline script without it
    (P8-03c1), so every page is rendered for its request; Zod's compiled parsers are off
    (`src/instrumentation-client.ts`), since the policy allows no eval;
  - `Strict-Transport-Security` (the site is only ever on https);
  - the browser keeps only a random id (for the rate limit), the cart and the orders sent from
    it;
  - the privacy notice and terms are at `/privacy` and `/terms` (drafts for legal review).

Configuration, read at request time:

| Variable    | What                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| `RELAY_URL` | The relay's functions, e.g. `https://<project>.supabase.co/functions/v1` (manual task 20) |

The relay must list this site's origin in `RELAY_ALLOWED_ORIGINS`. Restaurant PCs point their
table codes here with `RP_QR_SITE_URL`.

```
pnpm --filter @rp/qr-menu dev     # http://localhost:3100 (needs RELAY_URL)
pnpm --filter @rp/qr-menu test    # unit tests
pnpm --filter @rp/qr-menu e2e     # after `pnpm build`: a phone (Pixel 7) against a real relay
```
