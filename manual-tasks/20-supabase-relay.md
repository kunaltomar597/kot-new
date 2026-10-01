# 20. Deploy the QR relay to Supabase (Mumbai)

**Why:** the QR menu (Phase 5) runs through a cloud relay on Supabase. Claude has built the
relay's database and tested it locally and in CI, but cannot create your Supabase account or hold
its passwords. Until this is done, QR ordering works only in tests.

**Work packages:** P5-01 (database), P5-02 (edge functions), P5-03 (sync agent). The design is in
[ADR-0015](../docs/adr/0015-qr-relay-on-supabase.md).

**You need:**

- A Supabase account (OWNER_CHECKLIST item 10).
- About 30 minutes.
- The Supabase CLI on a computer with this repository: `brew install supabase/tap/supabase` on a
  Mac, or `npx supabase` anywhere.

Never paste a password, key or connection string into a Claude session, a commit or a chat.

## Steps

### 1. Create the organisation and three projects

1. At <https://supabase.com/dashboard>, create an organisation for the restaurant platform.
2. In it, create three projects, all in region **South Asia (Mumbai), `ap-south-1`**:
   - `rp-relay-dev` (Free plan is fine);
   - `rp-relay-staging`;
   - `rp-relay-prod` (a paid plan: Pro or higher, for daily backups and no pausing).
3. For each project, save its database password in your password manager. Supabase shows it only
   once.

### 2. Apply the relay schema (repeat per project, dev first)

From the repository root:

```sh
supabase login
supabase link --workdir infra --project-ref <project-ref>   # Project Settings → General
supabase db push --workdir infra                            # applies infra/supabase/migrations
```

`db push` lists the migrations it will apply. Expect `20261002130000_relay_schema.sql` and any
later ones. Answer `Y`.

### 3. Keep the relay schema private

In **Project Settings → Data API**, check that **Exposed schemas** lists only `public` and
`graphql_public`. `relay` must **not** be there (QR-006).

### 4. Give the edge functions their own login

Edge functions connect as `relay_edge`, which can only switch to the relay's roles. It is created
without a password; set one now.

1. Generate a password locally:

   ```sh
   openssl rand -base64 33 | tr -d '/+=' | cut -c1-40
   ```

2. Save it in your password manager.
3. In the **SQL editor** of the project, run:

   ```sql
   ALTER ROLE relay_edge WITH LOGIN PASSWORD '<the password>';
   ```

4. Build the connection string from **Connect → Transaction pooler**: user `relay_edge.<project-ref>`,
   port `6543`. Store it as a function secret. It never goes in the repository.

   ```sh
   supabase secrets set --workdir infra RELAY_DB_URL='postgresql://relay_edge.<ref>:<password>@<pooler-host>:6543/postgres'
   ```

### 4b. Deploy the edge functions

1. Set which sites may call the functions from a browser: the QR menu's address, without a
   trailing slash.

   ```sh
   supabase secrets set --workdir infra RELAY_ALLOWED_ORIGINS='https://<qr-site-domain>'
   ```

   For Realtime pickup of new orders (seconds instead of a polling interval), also give the
   functions the project's JWT secret. Find it under **Project Settings → JWT Keys → Legacy JWT
   Secret**. Copy it straight into the command; do not paste it anywhere else.

   ```sh
   supabase secrets set --workdir infra RELAY_JWT_SECRET='<legacy JWT secret>'
   ```

   Without it, local servers poll for new orders instead, which also works. Realtime also needs
   the project's public API key, which Supabase gives the functions as `SUPABASE_ANON_KEY`. If the
   project has only the new publishable key (legacy API keys turned off), set it too:

   ```sh
   supabase secrets set --workdir infra RELAY_REALTIME_API_KEY='<publishable key>'
   ```

   Menu photos need nothing more: the migrations create the public `menu-photos` bucket, and
   Supabase gives every function `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` itself. Never set
   or copy the service-role key anywhere else.

2. Bundle the functions, then deploy them:

   ```sh
   pnpm install && pnpm --filter @rp/relay... build
   supabase functions deploy --workdir infra
   ```

3. Check that the menu function answers. A made-up code should give `404` with `TABLE_NOT_FOUND`
   (real codes come with the table tents, P5-04):

   ```sh
   curl -i https://<project-ref>.supabase.co/functions/v1/qr-menu -H 'x-rp-table-token: AAAAAAAAAAAAAAAAAAAAAA'
   ```

### 4c. Connect a restaurant (until the Control Plane does it, P7)

The Control Plane will create each restaurant in the relay and hand its PC a credential (VCP-002).
Until then, do it by hand for the pilot restaurant.

1. On your computer, make a credential and its hash. Keep `credential.txt` safe and delete it
   afterwards.

   ```sh
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > credential.txt
   shasum -a 256 credential.txt | cut -d' ' -f1    # its SHA-256, for the next step
   ```

   `shasum` hashes the file exactly as written, without a newline; the relay hashes the same
   text.

2. In the project's **SQL editor**, with a new UUID for the restaurant:

   ```sql
   SELECT relay.provision_tenant('<restaurant uuid>', '<restaurant name>');
   SELECT relay.add_credential('<restaurant uuid>', decode('<sha256 hex>', 'hex'), 'Restaurant PC');
   ```

3. On the restaurant PC:
   - set `RP_RELAY_URL=https://<project-ref>.supabase.co/functions/v1` in the server's
     configuration;
   - store the credential, then restart the server:

     ```sh
     pnpm --filter @rp/server relay:credential < credential.txt
     ```

4. Within a minute the **System** page shows "QR menu online: In step, menu version 1".
5. Once the QR menu site is live (P5-05), also set `RP_QR_SITE_URL=https://<qr-site-domain>`,
   restart, and print the table tents from **Manage → QR codes**.

### 5. Check retention is scheduled

In the SQL editor, run:

```sql
SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'relay-purge';
```

You should see one row: `17 * * * *` and `SELECT relay.purge()`. Then check the expiry job:

```sql
SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'relay-expire';
```

You should see `* * * * *` and `SELECT relay.expire_orders()`.

Then check the photo bucket:

```sql
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'menu-photos';
```

You should see one row: `true`, `2097152` and `{image/webp}`.

If you set `RELAY_JWT_SECRET`, check the Realtime doorbell once the pilot restaurant is connected:
about 15 seconds after the local server starts, its System page should say "New QR orders arrive
instantly". Order a dish from a table's QR page; it should reach the waiter within a couple of
seconds. "Checked every few seconds" means the server is polling: send the server log lines that
mention Realtime. Once the pilot restaurant is
connected, give a QR dish a photo in the console, publish the menu, and open the table's QR page on
a phone: the photo should show beside the dish within a minute.

## Results to report back

Copy this into a Claude session (no passwords or keys):

```
Supabase relay deployment
- Organisation created: yes/no
- Projects (name → project ref, region):
  - dev:     ______ (ap-south-1)
  - staging: ______ (ap-south-1)
  - prod:    ______ (ap-south-1), plan: ______
- Migrations applied (dev/staging/prod): __/__/__
- Exposed schemas exclude relay (dev/staging/prod): __/__/__
- relay_edge login set and RELAY_DB_URL secret stored (dev/staging/prod): __/__/__
- Functions deployed, RELAY_ALLOWED_ORIGINS set, qr-menu answers 404 for a made-up code: __/__/__
- RELAY_JWT_SECRET set (Realtime) or left out (polling) (dev/staging/prod): __/__/__
- System page says "New QR orders arrive instantly" (pilot): yes/no
- relay-purge and relay-expire jobs present (dev/staging/prod): __/__/__
- menu-photos bucket present and public (dev/staging/prod): __/__/__; a dish photo shows on the
  pilot's QR page: yes/no
- Pilot restaurant connected; System page shows the QR relay in step: yes/no
- Anything that did not match these steps:
```
