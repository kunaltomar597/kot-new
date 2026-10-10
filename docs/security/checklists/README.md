# Standards checklists

BRD §8.1 sets the standards the platform is measured against, and P8-03d asks for each checklist
with every control's status and its evidence. Written in P8-03d2b2d (2026-10-11).

| Checklist                                  | Standard                                                            | Covers                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [ASVS L2, Top 10, API Top 10](asvs.md)     | OWASP ASVS 4.0.3 Level 2, Top 10 (2021), API Security Top 10 (2023) | The local server, the web console, the QR site, the relay functions and the Control Plane     |
| [MASVS-L1 with resilience](masvs.md)       | OWASP MASVS v2                                                      | The waiter app and the table tablet in kiosk mode, with their shared code                     |
| [ETSI EN 303 645](etsi-en-303-645.md)      | ETSI EN 303 645 (the 13 provisions of its clause 5)                 | The wrist pager: the PC's side is built; the pager's side waits for its firmware (P2-05)      |
| [CIS for the Windows host](cis-windows.md) | CIS Microsoft Windows 11 Benchmark, cut down to a restaurant PC     | Accounts, firewall, BitLocker, updates and the installer, with the runbook and manual task 35 |

## How each is written

- A row is a control group (an ASVS section, a MASVS control, an ETSI provision, a CIS setting
  group), not all 280 ASVS requirements one by one. Where a row would hide a gap, it is split.
- **Status**: `Met` (with evidence), `N/A` (with the reason in Notes) or `Finding` (with
  `Plan: <work package or manual task N> by <date>` in Notes).
- **Evidence**: files and folders in the repository, or threat ids (`PC-E2`) from
  [the threat models](../threat-models/README.md), in backticks. The tests behind a threat are in
  its model.
- A control is `Met` only when the software or a procedure as built does it; what depends on an
  account, a device or a person is a Finding with its plan, as in the threat models.

## The checks

`pnpm security:checklists` (`infra/ci/check-checklists.mjs`, run by `pnpm check`) fails when a
checklist is missing, a row is malformed, a status is not one of the three, a `Met` has no evidence,
an `N/A` has no reason, a file or threat named does not exist, or a plan names a work package that
does not exist or is already done (finish it by updating the control) or a manual task that does not
exist. Its tests (`infra/ci/check-checklists.test.mjs`, `pnpm ci:test`) carry SEC-010 and SEC-011.

## Keeping them current

A pull request that changes a control updates its row; a work package a plan names turns its
findings into `Met` when it is done. Before the penetration test and at each major release, read
every row against the code again (SEC-000).

## The Electron review and the MDM policy

The Electron hardening review (SEC-011) is the [desktop shell model](../threat-models/desktop-shell.md)
with the shell's code and tests (P8-03d1). The MDM policy (SEC-010) is
[the MDM runbook](../../runbooks/mdm-policy.md) (P8-03d2a); its device checks are manual task 33.
