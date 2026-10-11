# Vendor access policy

For everyone at the vendor who runs the Vendor Control Plane or supports a restaurant. It sets out
what vendor staff may see and do, and how that is checked. Requirements: VCP-007, AUTH-014,
UPD-008, UPD-009, SEC-018, DATA-003.

The owner of this policy is the vendor's Super Admin. Review it with every quarterly access
review (below) and whenever a role or capability changes.

## 1. What the vendor holds, and what it never holds

The restaurant's business data stays on the restaurant's PC (NFR-A01, DATA-001). This includes
orders, bills, payments, customers, staff, the audit log and reports.

The Control Plane holds only what is needed to licence, bill, update and support the restaurant:

| Held by the Control Plane                                                   | Why                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| Restaurant name, legal name, GSTIN, contacts, address                       | Licences, the vendor's invoices, onboarding       |
| Installations, their public keys and PC fingerprint                         | Enrolment and licence binding (LIC-004)           |
| Heartbeats: versions, disk, device counts, licence state, audit-chain head  | Fleet health and tamper checks (VCP-005, AUD-003) |
| Licences, subscriptions, the vendor's invoices and payments                 | LIC-001 to LIC-009, VCP-003                       |
| Support notes written by vendor staff                                       | VCP-007                                           |
| The restaurant's QR-relay credential, sealed, until its PC holds it         | VCP-002, VCP-008                                  |
| The vendor's own audit log                                                  | SEC-018                                           |
| Each restaurant's nightly backup file, encrypted on its PC with its own key | DATA-003: surviving the loss of the PC (P7-05d)   |
| Each PC's backup key, wrapped by the vendor's KMS key (escrow)              | DATA-003, OI-10: restore onto a new PC (P7-05e)   |

The Control Plane never receives order, bill, payment, customer or staff records. The heartbeat
contract (`packages/contracts/src/control-plane/schemas.ts`) has no field for any of them. The
local server builds each heartbeat from those named fields only
(`apps/server/src/cloud/heartbeat.service.ts`). The Control Plane keeps fields it does not know
yet, so that a newer PC is never refused. For that reason, any change that adds a field to the
heartbeat must be checked against this policy in review.

The cloud backups (DATA-003) hold the whole restaurant database, but encrypted on the restaurant's
PC with the PC's backup key before they leave. The Control Plane stores them in India. It holds
that key only wrapped by the vendor's KMS key, which unwraps it only for a restore code (§3):
vendor staff can list a PC's backups (when and how large), not read them.

The QR relay holds the restaurant's published menu and the diners' orders in transit (P5). Vendor
staff do not read relay data, except to diagnose a fault the restaurant has reported, through
the diagnostics route in §3.

## 2. No standing access to a restaurant (AUTH-014, UPD-009)

- There is no remote shell, hidden account, master password or back door into a restaurant's
  PC, server, database or devices. None will be added.
- Vendor staff cannot sign in to a restaurant's POS, console or apps. The restaurant's own staff
  accounts and PINs are the only way in.
- Screen sharing happens only when the restaurant starts the session with a standard tool (for
  example AnyDesk or Google Meet) and ends it when it wants. Vendor staff never ask for the
  restaurant's passwords, PINs or 2FA codes, including during screen sharing.
- The restaurant's database listens on its own PC only (DATA-001). The vendor has no network
  route to it.

## 3. The only two routes to business data

Vendor staff see business data only through:

1. **Diagnostics (UPD-008, P7-08).** The manager sends a diagnostics bundle from the console:
   logs, versions, configuration without secrets, and the device list. Support may _request_ a
   bundle from the Control Plane. The restaurant's manager is then asked and must allow it. Without
   that consent nothing is sent.
2. **Backups (DATA-003, P7-05).** Cloud backups are encrypted on the restaurant's PC before upload.
   Each PC's backup key is escrowed wrapped by the vendor's KMS key, whose private half never
   leaves the KMS (P7-05e). It is released only through a restore code:
   - Support or the Super Admin issues it only after verifying, by the restore policy (OI-10),
     that they are speaking to the restaurant's Owner, and records how;
   - the code works once, within 24 hours, and only in the restore tool on a new PC, which gets
     the key wrapped for a key it made itself;
   - the restaurant's Owner is alerted on the POS and dashboard when a code is issued, and each
     issue and release is in the vendor audit log;
   - vendor staff never run the restore tool themselves and never decrypt a backup to read it.
     The quarterly access review (§6) checks every restore code against its ticket.

A bundle or restore is handled only for the ticket it was given for, and kept no longer than that
ticket needs. The Control Plane deletes every diagnostics bundle 30 days after it arrived, and
audits it (`diagnostics.removed`); a copy taken for a ticket goes with the ticket's closing. A
bundle or restore is never copied to personal devices, chat tools or email.

## 4. Roles and least privilege (SEC-018)

Every vendor staff member has a personal account with one role. Shared accounts are not allowed.
The Control Plane enforces what each role may do, deny by default (`vendorMay` in
`packages/contracts/src/control-plane/vendor.ts`):

| Capability                                                               | Super Admin | Onboarding | Support | Finance | Read-only |
| ------------------------------------------------------------------------ | :---------: | :--------: | :-----: | :-----: | :-------: |
| See the fleet, restaurants, licences, notes                              |      ✓      |     ✓      |    ✓    |    ✓    |     ✓     |
| Create and edit restaurants, installations, codes, QR-relay provisioning |      ✓      |     ✓      |         |         |           |
| Re-bind a licence to a new PC                                            |      ✓      |     ✓      |    ✓    |         |           |
| Issue a reactivation code                                                |      ✓      |            |    ✓    |    ✓    |           |
| Write support notes                                                      |      ✓      |     ✓      |    ✓    |         |           |
| Change licence terms and state                                           |      ✓      |            |         |    ✓    |           |
| Plans, subscriptions, invoices, payments                                 |      ✓      |            |         |    ✓    |           |
| Read the vendor audit log                                                |      ✓      |            |         |    ✓    |           |
| Manage vendor staff accounts and access reviews                          |      ✓      |            |         |         |           |
| Publish releases                                                         |      ✓      |            |         |         |           |
| Push vendor settings and feature flags to PCs                            |      ✓      |            |         |         |           |
| Ask a restaurant for diagnostics; open a bundle                          |      ✓      |     ✓      |    ✓    |         |           |
| Issue a restore code for a restaurant's cloud backups (Owner verified)   |      ✓      |            |    ✓    |         |           |

Give each person the narrowest role that fits their work. A second role for one person is not
possible; when duties change, change the role and record why in the account change.

## 5. Signing in (SEC-018)

- Every account needs a password (at least 12 characters) **and** an authenticator app code
  (TOTP). An account cannot be used until both are set up through its one-time setup link,
  which is valid for 72 hours.
- Five failed sign-ins lock the account for 15 minutes, however fast they come. A wrong email, a
  disabled account and a wrong password get the same answer.
- A session ends after 8 hours, or after 30 minutes without use, or at sign-out.
- A lost authenticator: a Super Admin resets the account. This ends its sessions and issues a new
  setup link. Hand the link over in person or by phone, never in the same channel as the email
  address. Nobody resets their own account.
- A Super Admin's account takes two other Super Admins: the first presses Reset (nothing changes
  yet, and the Staff page shows the request), the second presses Reset within 24 hours and gets
  the setup link. Keep at least three Super Admins so that one can be reset. With only two, the
  operator creates a new Super Admin with the CLI on the operator host
  (`vendor-user:create`, audited as `cli:<name>`), who then disables the old account.
- Restoring a restaurant's data, managing staff accounts, publishing releases and pushing
  settings ask for the authenticator again, however recent the sign-in. Enter a code that the app
  shows now and that you have not used: after signing in, wait for the next code. A wrong code
  counts towards the same lock as a wrong sign-in.
- Disabling an account ends its sessions at once. Disable an account on the day its holder leaves.

## 6. Quarterly access review (SEC-018)

Every quarter (January, April, July, October), a Super Admin:

1. Lists every active account with its role and last sign-in (`GET /v1/vendor/users`, or the
   Staff page of the web app).
2. Confirms with each team lead who still needs access, and at which role.
3. Records the review (`POST /v1/vendor/access-reviews`) with the accounts to keep and a note.
   Every other active account, except the reviewer's own, is disabled and its sessions end. At
   least one Super Admin is always kept.
4. Checks the vendor audit log for unusual actions since the last review: reactivation codes,
   re-binds, restore codes and key releases (each against its ticket), licence changes and
   account changes.
5. Reviews the access of the infrastructure behind the Control Plane: the hosting account, the
   secret manager, the KMS key (manual task 23), the QR relay project and the code host. Each must
   have MFA and personal accounts.

## 7. Every action is audited (UPD-009, SEC-018)

Every change made through the Control Plane, by any vendor staff member or the CLI, writes an
audit entry with the actor (`vendor:<id>` or `cli:<name>`), the target, and the details or reason.
This includes notes, provisioning, licence changes, re-binds, reactivation codes, billing and
account changes. The log is append-only: the database refuses changes and deletions. Support
notes are append-only as well; a correction is a new note.

Each entry is also written to the Control Plane's log (`"event":"audit"`) and kept 180 days in
the hosting provider's log store in India, which no vendor staff account can change (SEC-015;
manual task 34). A line may name a change that was rolled back: the database is the record.

Reads: opening a diagnostics bundle and issuing a restore code are audited; every other screen
shows the Control Plane's own records (fleet state, licences, versions, billing, notes), not a
restaurant's business data. A new screen that shows business data must be audited, and the test
`read-audit.test.ts` fails until each new read is classified.

The admin CLI runs only on the operator host or in the deployment pipeline, never on a laptop.
Only the operators named in the access review have a shell there, each under their own account
with MFA and the provider's session recording; `CP_ACTOR` names the person (`cli:<name>`).

Production access outside the Control Plane is audited too: database access goes through the
hosting provider's audited sessions. The CLI records `CP_ACTOR`, which must name the person.

## 8. Breaches of this policy

Anyone who finds access beyond this policy (a shared account, a back door, data where it should
not be) reports it to the Super Admin the same day. The Super Admin disables the affected
access, records what happened in a support note or incident record, and, where a restaurant's
data may be affected, tells its Owner.
