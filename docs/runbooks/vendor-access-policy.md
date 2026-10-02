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

| Held by the Control Plane                                                  | Why                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------- |
| Restaurant name, legal name, GSTIN, contacts, address                      | Licences, the vendor's invoices, onboarding       |
| Installations, their public keys and PC fingerprint                        | Enrolment and licence binding (LIC-004)           |
| Heartbeats: versions, disk, device counts, licence state, audit-chain head | Fleet health and tamper checks (VCP-005, AUD-003) |
| Licences, subscriptions, the vendor's invoices and payments                | LIC-001 to LIC-009, VCP-003                       |
| Support notes written by vendor staff                                      | VCP-007                                           |
| The restaurant's QR-relay credential, sealed, until its PC holds it        | VCP-002, VCP-008                                  |
| The vendor's own audit log                                                 | SEC-018                                           |

The Control Plane never receives order, bill, payment, customer or staff records. The heartbeat
contract (`packages/contracts/src/control-plane/schemas.ts`) has no field for any of them. The
local server builds each heartbeat from those named fields only
(`apps/server/src/cloud/heartbeat.service.ts`). The Control Plane keeps fields it does not know
yet, so that a newer PC is never refused. For that reason, any change that adds a field to the
heartbeat must be checked against this policy in review.

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
   The vendor's escrowed copy of the key is released only on the Owner's own authenticated restore
   request, and only to restore that restaurant's system. Vendor staff never decrypt a backup to
   read it.

A bundle or restore is handled only for the ticket it was given for, and kept no longer than that
ticket needs (at most 30 days for a diagnostics bundle). It is never copied to personal devices,
chat tools or email.

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

Give each person the narrowest role that fits their work. A second role for one person is not
possible; when duties change, change the role and record why in the account change.

## 5. Signing in (SEC-018)

- Every account needs a password (at least 12 characters) **and** an authenticator app code
  (TOTP). An account cannot be used until both are set up through its one-time setup link,
  which is valid for 72 hours.
- Five failed sign-ins lock the account for 15 minutes.
- A session ends after 8 hours, or after 30 minutes without use, or at sign-out.
- A lost authenticator: a Super Admin resets the account. This ends its sessions and issues a new
  setup link. Hand the link over in person or by phone, never in the same channel as the email
  address.
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
   re-binds, licence changes and account changes.
5. Reviews the access of the infrastructure behind the Control Plane: the hosting account, the
   secret manager, the KMS key (manual task 23), the QR relay project and the code host. Each must
   have MFA and personal accounts.

## 7. Every action is audited (UPD-009, SEC-018)

Every change made through the Control Plane, by any vendor staff member or the CLI, writes an
audit entry with the actor (`vendor:<id>` or `cli:<name>`), the target, and the details or reason.
This includes notes, provisioning, licence changes, re-binds, reactivation codes, billing and
account changes. The log is append-only: the database refuses changes and deletions. Support
notes are append-only as well; a correction is a new note.

Production access outside the Control Plane is audited too: database access goes through the
hosting provider's audited sessions. The CLI records `CP_ACTOR`, which must name the person.

## 8. Breaches of this policy

Anyone who finds access beyond this policy (a shared account, a back door, data where it should
not be) reports it to the Super Admin the same day. The Super Admin disables the affected
access, records what happened in a support note or incident record, and, where a restaurant's
data may be affected, tells its Owner.
