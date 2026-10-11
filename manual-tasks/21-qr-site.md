# 21. Put the QR menu site online

**Why:** the table QR codes (P5-04) open the QR menu site, `apps/qr-menu`. Claude built it and
tests it on a phone against a real relay, but cannot create the hosting account or the domain.

**Work packages:** P5-05.

**You need:**

- The QR relay set up first ([manual task 20](20-supabase-relay.md)).
- A domain for the site, e.g. `menu.<your-domain>` (OWNER_CHECKLIST: domain + DNS).
- A hosting account that runs Next.js and serves from India. For example Vercel, with its
  Mumbai region `bom1` (the BRD asks for India presence and a CDN).

Never paste a password, key or token into a Claude session or a commit.

## Steps

1. In the hosting dashboard, create a project from this repository:
   - root directory: `apps/qr-menu`;
   - install command: `pnpm install --frozen-lockfile` (run at the repository root);
   - build command: `pnpm turbo run build --filter=@rp/qr-menu...`.
2. Set the environment variable `RELAY_URL=https://<project-ref>.supabase.co/functions/v1`
   (the relay of the matching environment: dev, staging or prod).
3. Choose the Mumbai region for the server functions, then deploy.
4. Add the domain, e.g. `menu.<your-domain>`, and its DNS record as the host instructs. Wait for
   HTTPS.
5. Let the relay accept calls from the site:

   ```sh
   supabase secrets set --workdir infra RELAY_ALLOWED_ORIGINS='https://menu.<your-domain>'
   ```

6. On each restaurant PC, set `RP_QR_SITE_URL=https://menu.<your-domain>`, restart the server,
   then print the tents from **Manage → QR codes**.
7. Check with a phone:
   - scan a table's code: the restaurant's menu and the table's label appear;
   - order something: within seconds it waits for approval on the waiter app or the POS;
   - approve it: the phone says "Your order has been sent to the kitchen".

8. Check what the deployed site sends (P8-03c1; the scan in CI runs on plain http and cannot see
   the host's TLS):

   ```sh
   curl -sI "https://menu.<your-domain>/t/<a table's code>" | grep -iE 'content-security|strict-transport|x-frame'
   ```

   The policy names a `'nonce-…'` that changes on every request, `Strict-Transport-Security`
   is there, and `X-Frame-Options: DENY`. Then the host's own TLS: SSL Labs
   (`https://www.ssllabs.com/ssltest/`) on the address grades it A or better.

## Results to report back

```
QR menu site
- Host and region: ______
- Address: https://______
- RELAY_URL set (dev/staging/prod): __/__/__
- RELAY_ALLOWED_ORIGINS includes the site: yes/no
- RP_QR_SITE_URL set on the pilot PC: yes/no
- Phone test (menu shows / order reaches approval / "sent to the kitchen" shows): __/__/__
- Headers (nonce changes / HSTS / X-Frame-Options): __/__/__; SSL Labs grade: __
- Anything that did not match these steps:
```
