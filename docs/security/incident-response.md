# Incident response plan

SEC-016 (BRD §8, §12): severity levels, contacts and on-call, regulatory reporting (CERT-In within
6 hours; DPDP breach notifications), templates for restaurants and an annual tabletop exercise.
Written in P8-03e (2026-10-11). **The Business Owner reviews it and fills the contact table before
the pilot** ([manual task 36](../../manual-tasks/36-incident-response-and-pentest.md)). Until the
names are filled in, this is a plan with blanks, and the pilot's entry criteria say so (P8-06).

Related: [threat models](threat-models/README.md) (what can go wrong, by component),
[templates](incident-templates.md), [vendor access policy](../runbooks/vendor-access-policy.md),
[backups and restoring](../runbooks/backups.md), [control plane runbook](../runbooks/control-plane.md).

## Who is who

The vendor is a **data processor** for what it holds for a restaurant (QR relay, cloud backups,
diagnostics); the restaurant is the **data fiduciary** for its diners' and staff personal data (BRD
§9.2). The vendor is the fiduciary only for its own customers' account data. This decides who tells
whom (below).

| Role                     | Who                                            | Does                                                                                     |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Incident commander (IC)  | _name, phone, email: the Business Owner names_ | Declares and closes the incident, sets the severity, owns the log, decides what is said  |
| Deputy IC                | _name, phone_                                  | Acts when the IC cannot be reached within 30 minutes                                     |
| CERT-In point of contact | _name, phone, email (BRD §19.2)_               | Files the CERT-In report and answers CERT-In                                             |
| Technical lead           | _name_                                         | Contains, investigates and recovers; keeps the evidence                                  |
| Communications           | _name_                                         | Sends the restaurant and diner messages from [the templates](incident-templates.md)      |
| Legal counsel            | _name, firm_                                   | Decides whether the DPDP duties are triggered and words the notices                      |
| Restaurant's own contact | The Owner of each restaurant                   | Is the fiduciary: decides, with the vendor's help, whether the Board and diners are told |

**On call.** One technical person is on call at all times during the pilot and the first paid
rollout (rota in the shared calendar; the person on call has the Control Plane CLI host and the
Supabase project access at hand: [vendor access policy](../runbooks/vendor-access-policy.md)).
Restaurants reach support on _support phone and email_, answered within 15 minutes for a SEV1 and 1
hour for a SEV2 during opening hours. Anyone who suspects an incident tells the IC; nobody waits to
be sure.

## Severity levels

| Level | Meaning                                                                                                                                  | Examples                                                                                                                                      | Respond within | Update every |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ |
| SEV1  | Personal or financial data exposed or at risk; code running that the vendor did not sign; a restaurant cannot trade; a vendor key leaked | A signing key or relay secret leaked; a Control Plane breach; ransomware on a restaurant PC; a bad update on many PCs; the audit chain broken | 30 minutes     | 1 hour       |
| SEV2  | A security control failed but nothing is known to be exposed; one restaurant degraded                                                    | A credential used from an unexpected place; a fake QR sticker reported; a PC offline during opening hours; licence tampering alert            | 2 hours        | 4 hours      |
| SEV3  | A weakness with no sign it was used                                                                                                      | A vulnerability reported by a researcher; a failing dependency audit; an unusual scan in the logs                                             | 1 working day  | Weekly       |

When unsure, take the higher level and lower it later. The IC may raise a level at any time.

## The steps of every incident

1. **Detect and record.** Open a log (a dated document the IC owns) with: who found it, when (IST
   and UTC), what was seen, which restaurants. Sources: a fleet alert (offline, backup failed,
   **audit chain mismatch**, **licence tampering**, **takes unsigned updates**:
   [control plane runbook](../runbooks/control-plane.md)), a restaurant's call, a researcher's
   email, the Supabase or hosting provider, CI's release checks, the logs of the Control Plane host.
2. **Classify.** The IC sets the severity and decides who is brought in. Start the **6-hour clock**
   at the moment the vendor _became aware_ of a reportable incident (below), not when it ended.
3. **Contain.** The smallest action that stops the harm and keeps the evidence (the playbooks
   below). Never wipe a PC or delete logs before the technical lead has copied them. Restaurants
   keep trading offline (NFR-A01): containment never needs the restaurant to stop serving.
4. **Report.** CERT-In, the restaurant, and (through the restaurant, or the vendor for its own data)
   the Data Protection Board and diners, as below.
5. **Eradicate and recover.** Remove the cause, restore from a checked backup, rotate every secret
   the incident could have touched, and confirm with the checks in the playbook.
6. **Review within 5 working days.** A blameless write-up: timeline, cause, what worked, what
   did not, changes. Each change becomes a work package or a threat-model update in the same
   month ([threat models, keeping them current](threat-models/README.md#keeping-them-current)).
   Close the log.

## Reporting to CERT-In (within 6 hours)

Under the CERT-In Directions of 28 April 2022 (BRD §12) specified cyber incidents are reported
**within 6 hours of noticing them**. The point of contact files it by email to `incident@cert-in.org.in`
(the address and form on cert-in.org.in at the time: check them, they change), using the form's
fields, and sends a first report even when facts are missing; later reports add them.

Report (these are the kinds that apply to this product):

- unauthorised access to an IT system or data; a compromise of a server or application;
- a data breach or data leak; an attack on a server such as a database or application;
- identity theft, spoofing or phishing against the platform or its users;
- malicious code on the platform's systems, including ransomware;
- attacks that affect IoT devices (the pagers) and the systems around them;
- an attack on cloud systems the vendor runs (Control Plane, the relay).

A first report holds: who reports, what was seen and when, the systems and restaurants involved,
what is known about the cause, and what has been done. Keep the filing receipt in the log.

Also required by the same Directions and built into the platform (SEC-015, NFR-O04): **logs kept
180 days in India** (the Control Plane's audit log copy, manual task 34; the restaurant PC keeps its
own) and **clocks synchronised to NTP** (Windows time service; checked in the installer's readiness
list). Preserve both for the investigation; do not let the 180-day clean-up remove them while an
incident is open.

## Personal data breaches (DPDP Act 2023 and Rules)

A personal data breach is any unauthorised processing, or loss of access, that compromises the
confidentiality, integrity or availability of personal data. What the platform holds that counts:
diner names and phone numbers (QR relay, order records, receipts), staff names and phone numbers,
and restaurant contacts. Staff PINs are stored as hashes; payment card numbers are never held (the
platform records the method and amount only).

1. **Decide whether it is a personal data breach.** The technical lead lists the data and the
   restaurants; legal counsel confirms. A leak of menus or a table plan is not one.
2. **Who tells whom.** The vendor, as processor, tells **the affected restaurant's Owner (the
   fiduciary) without delay**, in the same hours as the CERT-In report, with the facts known. The
   restaurant, as fiduciary, tells the **Data Protection Board of India** and **each affected
   person**: without delay to each person, and to the Board a first notice without delay and the
   detailed report within **72 hours** (the Rules' period, confirmed by counsel before the pilot).
   For data the vendor holds as fiduciary (its customer accounts) the vendor does all of it.
3. **What the notices say.** The nature, extent, timing and place of the breach; its likely
   consequences; what was done to limit it; what the person can do to protect themselves; and a
   contact. Use [the templates](incident-templates.md).
4. **Help the restaurant.** The vendor drafts the restaurant's notices, lists affected persons from
   the records (the diner and staff exports of the erasure and export features,
   [data lifecycle](../runbooks/data-lifecycle.md)) and keeps its own copy of what was sent.
5. **Keep the record** of every breach, notified or not, with the reasons, for the audit.

## Playbooks

Each starts from the steps above. "Control Plane CLI" is `pnpm --filter @rp/control-plane cli`
([control plane runbook](../runbooks/control-plane.md)).

### A restaurant's relay credential is stolen or misused (RELAY-S3)

_Signs:_ orders or tables changing that the restaurant did not do; the relay's logs show calls from
somewhere that is not the restaurant; the restaurant reports a fake menu. _Level:_ SEV2, SEV1 if
diners' names were read.

1. In Supabase's SQL editor, as the provisioning login, revoke the credential at once (the PC's
   next call fails; the restaurant keeps trading on the LAN, only QR ordering stops):
   `SELECT relay.revoke_credential('<credential id>');` (ids: `SELECT id, label, revoked_at FROM relay.credentials WHERE tenant_id = '<restaurant id>';`).
   If it is unclear which one, suspend the restaurant: `SELECT relay.set_tenant_status('<restaurant id>', 'SUSPENDED');`.
2. Issue the next credential and store it on the PC: [manual task 20](../../manual-tasks/20-supabase-relay.md)
   steps for `relay.add_credential` and `pnpm --filter @rp/server relay:credential < credential.txt`,
   then restart the server. Shred `credential.txt`. Set the restaurant `ACTIVE` again.
3. Read the functions' logs for what the old credential did (menu publishes, table status, order
   rejections, diner reads). Anything that read diners' data is a personal data breach.
4. Find how it leaked (the PC's DPAPI store, a copied `credential.txt`, a laptop) and fix that.

### A fake QR sticker (RELAY-S4)

_Signs:_ a diner or staff member reports a QR tent that goes elsewhere, a sticker over the real one,
a "pay here" page. _Level:_ SEV2; SEV1 if diners paid or gave details to a look-alike site.

1. At the restaurant now: peel off every sticker, then check **every table's tent** against its
   printed address (the tent shows the site's address as text). The restaurant's staff do this at
   each opening, see the guidance in [the templates](incident-templates.md#guidance-for-restaurants-qr-tents-and-stickers).
2. Give every affected table a new code (**Manage → QR codes → New code**, with the reason); the old
   code stops within seconds ([QR relay runbook](../runbooks/qr-relay.md)) and print new tents.
3. Take the look-alike site down: report it to its host and registrar (abuse contact), and to
   CERT-In if diners were defrauded. Collect its address, a screenshot and the time.
4. If diners entered details or paid: tell them ([diner notice](incident-templates.md#to-diners)),
   and if it was personal data, follow the DPDP section. The real site never takes payment (its
   terms say so); say that in the notice.
5. Keep the vendor's domain recognisable (manual task 21) so diners learn what the real address looks like.

### Ransomware, or a dead disk, on a restaurant PC (PC-D7)

_Level:_ SEV1 (the restaurant cannot trade, data at risk). The restaurant runs on paper tickets
meanwhile; the phones and tablets keep their queued orders (outbox) but nothing syncs.

1. **Isolate:** unplug the PC's network cable and Wi-Fi; do not turn it off if it is still running
   (memory holds evidence) unless the encryption is spreading, then power it off. Do not pay or
   contact the attacker; the IC and counsel decide anything on that.
2. **Report:** CERT-In within 6 hours (malicious code/ransomware); the restaurant's Owner at once.
   If data was copied out (double extortion), it is a personal data breach.
3. **Do not reuse the PC's disk.** Prepare a new or clean PC, install the same version, and restore
   with the recovery key onto it: [backups, "On a new PC"](../runbooks/backups.md#on-a-new-pc) or
   [from the cloud](../runbooks/backups.md#from-the-cloud-onto-a-new-pc-p7-05e) when the
   PC's backup drives were also reached. Target: back in service in under 4 hours (RTO), losing at most
   what the continuous backup had not yet shipped (RPO; measured by `restore.int.test.ts`).
4. After restoring: `installation:revoke` the old installation and move its licence to the new PC
   (`licence:rebind`, with a reason); re-pair every device (the new CA); **rotate the relay
   credential** (playbook above) because the old PC held it; staff PINs are hashed, so they need no
   change unless the attacker had the database, in which case reset them all. The Control Plane's date check
   makes the old PC's older state useless (`control-plane.md`).
5. Check the audit chain on the restored PC (System page) against the chain head the Control Plane
   holds: a mismatch is a separate SEV1.
6. Review: how it got in (a staff account, a USB, email on the POS PC, an administrator password),
   and apply [Windows host controls](../runbooks/windows-host.md). Backups on a drive that stays
   connected are also reachable: confirm the offline/cloud copy is intact and its object lock holds.

### A vendor key or the signing certificate leaks (LICENCE-I3, UPDATE-I1)

_Level:_ SEV1. Stop all releases and rollouts (`release` channel paused in the Control Plane).
Follow the key's own procedure: licence key: manual task 23; code-signing certificate: manual
task 31; pager firmware key: manual task 30; the key escrow: manual task 27. Revoke or replace
the key, ship a signed release carrying the new trust anchor, and check no unsigned or
wrongly signed build was offered (releases, rollout history, `Takes unsigned updates` alerts).
Every restaurant that took an update signed since the earliest possible leak is told.

### A bad or malicious update (UPDATE-T6, UPDATE-E2)

_Level:_ SEV1 if more than one restaurant. Pause the rollout; withdraw the release; restaurants that
installed it go back with the updater's rollback ([software updates](../runbooks/software-updates.md));
the technical lead compares the release's evidence (the `release-evidence` CI job, the manifest) with
what was built; every restaurant that took it is told.

### The Control Plane or the relay is breached (CP-_, RELAY-_)

_Level:_ SEV1. Rotate the hosting and database secrets, the Supabase service keys and the vendor
users' sessions; freeze remote settings and releases; compare the audit log copy kept for 180 days
with the database. Restaurants keep working offline. Work out which tenants' data (diagnostics,
cloud backups, relay diner data) was reachable: those are personal data breaches for the restaurants
concerned. Cloud backups are encrypted with the restaurant's own recovery key, so a copy taken from the
bucket alone is not readable; say that in the notice, with the facts.

### A stolen or lost device (phone, tablet, pager)

_Level:_ SEV3 normally. Deactivate the device on the Devices page (its token stops at once); a
pager is deactivated on the Pagers page; a tablet in kiosk mode holds no staff PIN. If a waiter phone
was unlocked and signed in, deactivate the person's sessions too (Staff page → deactivate/reactivate).

### Licence tampering or an audit chain mismatch (fleet alerts)

Follow `control-plane.md` ("Licence tampering", "An audit chain mismatch"), classify as SEV2, and
raise it to SEV1 if the cause is a breach rather than a fault or a restaurant's own doing.

### A vulnerability reported to us (ETSI 5.2)

Researchers write to _security contact address, e.g. security@vendor domain_ (published on the
vendor's website and in the product's About page with this policy; fill in and publish before the pilot). We
acknowledge **within 3 working days**, give a first assessment within 10, keep the reporter informed,
fix by severity (Critical/High before anything else ships; Medium with a dated plan, SEC-017), and
credit the reporter if they wish. We ask for reasonable time to fix (90 days) and do not take
action against good-faith research that avoids other people's data and does not disrupt service.
Classify as SEV3 (or higher if exploited).

## Evidence and communications rules

- Keep the log, screenshots, exports of alerts, the relevant logs (not edited) and the filing
  receipts in one restricted folder; hash the files when copied.
- Say only what is known. Correct earlier statements when facts change. One voice: the
  Communications lead; restaurants are not told different things by different people.
- Do not name individuals as culprits in any notice. Do not send personal data in email notices
  beyond what the person needs.
- Never put secrets, PINs or recovery keys in the incident log or chat.

## The annual tabletop exercise (SEC-016)

Once a year, and once before the pilot starts: the IC runs a 2-hour exercise with everyone in the
table above. One scenario from the playbooks (rotate: ransomware at a restaurant; a stolen relay
credential read diners' names; a leaked signing certificate; a fake sticker that took payments), a
timeline injected by the IC, and the people play their roles using the real tools and templates
(find the CLI, find the CERT-In form, draft the restaurant notice). Record in the log: time to
declare, time to the CERT-In first report (target under 4 hours), gaps found, and the changes made.
Findings are fixed within 30 days, and the plan is updated. The first exercise: before the pilot
(manual task 36). Repeat after any real SEV1.

| Date | Scenario | Time to CERT-In report | Gaps and changes |
| ---- | -------- | ---------------------- | ---------------- |
|      |          |                        |                  |
