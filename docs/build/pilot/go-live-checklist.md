# Go-live checklist for the pilot (P8-06)

The Business Owner ticks each line and signs at the end. BRD §18.3 pilot entry: all of S1-S14
pass, no open Sev-1 or Sev-2, and the penetration test has no open Critical or High finding.

## 1. Software

- [ ] `pnpm check` and `pnpm trace --strict` pass on the release candidate (CI link: ____).
- [ ] The Must requirements waiting for a person (`docs/build/manual-evidence.json`, listed at the
      end of `docs/build/TRACEABILITY.md`) each have their evidence recorded below.
- [ ] `pnpm contracts:freeze --release <x.y.z>` run for the pilot release; the compatibility check
      compares against it from now on.
- [ ] The signed installer, APKs and pager firmware come from the release pipeline (tasks 14, 29,
      30, 31).
- [ ] Zero open Sev-1 or Sev-2 defects (list: ____).

## 2. Scenarios and tests

- [ ] S1-S14 pass (`uat-plan.md`, results table filled).
- [ ] Failure drills done (task 18), restore rehearsal timed (task 25).
- [ ] Penetration test finished, no open Critical or High finding (task 36); the incident response
      plan has its names, phones and CERT-In contact filled in (task 36, step 1).

## 3. Site readiness

- [ ] The site-readiness checklist (ONB-011, `docs/onboarding/README.md`) signed by the restaurant.
- [ ] Wi-Fi coverage walk test passed (task 11); staff Wi-Fi is separate from guest Wi-Fi.
- [ ] UPS on the PC and the router; BitLocker on; the PC has its own accounts (task 35).
- [ ] Printers and cash drawer tested (task 13); tablets in kiosk mode (task 12); pagers charged and
      paired.
- [ ] The router blocks everything except the vendor and relay domains (task 35).

## 4. Accounts and paper

- [ ] Control Plane, relay, QR site, backup storage, error reporting live (tasks 20-28, 32, 34).
- [ ] Pilot agreement and the subscription terms match the licence states (LIC-009, OI-08).
- [ ] The restaurant's CA has confirmed the invoice template; privacy notices reviewed (DPDP).
- [ ] Staff trained from `docs/manuals/`; everyone has their own PIN; the Owner has the TOTP set up.
- [ ] Baseline KPIs measured before the pilot (`kpi-plan.md`, section 3).

## 5. Evidence for the requirements a person proves

| Requirement | Evidence (date, who, where it is kept) |
| ----------- | -------------------------------------- |
| ONB-008     |                                        |
| UPD-009     |                                        |
| TAB-016     |                                        |
| NFR-U06     |                                        |
| NFR-M05     |                                        |
| PGR-002     |                                        |
| PGR-004     |                                        |
| PGR-009     |                                        |
| PGR-010     |                                        |
| LIC-009     |                                        |

## 6. Sign-off

Business Owner: ____________________ Date: ____________

Pilot length: at least 4 weeks (BRD §18.3, a setting for the owner). Commercial launch needs no
Sev-1 in the last 2 weeks and the KPIs reviewed (`kpi-plan.md`).
