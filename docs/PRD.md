# PRD: Restaurant Operations Platform

A two-page summary of the signed-off BRD, for orientation. The BRD
(`docs/brd/Restaurant_Platform_BRD_v1.0.pdf`, searchable as `docs/brd/brd-v1.0.txt` and
`docs/brd/requirements.md`) is authoritative. If this file and the BRD disagree, the BRD wins and
this file is fixed in the same pull request. Build status comes from `docs/build/PROGRESS.md`.

## 01 Product overview

| Field        | Value                                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product name | Restaurant Operations Platform (working title until OI-01 is decided)                                                                                                                                                                                                                         |
| Tagline      | Local-first POS, kitchen and floor system for Indian restaurants                                                                                                                                                                                                                              |
| Description  | One system that runs a dine-in or takeaway restaurant from the diner's table to the kitchen and back to the GST bill. It runs on the restaurant's own Windows PC and keeps working without internet. The vendor sells it as a subscription and operates the fleet from a cloud Control Plane. |
| Stage        | In development: 63 of 111 work packages done (Phases 0 to 2 software complete, Phase 3 and 4 in progress). No pilot yet.                                                                                                                                                                      |
| Platform     | Windows service + web console (POS, dashboard, KDS), Android apps (waiter, table tablet), public Next.js QR site, ESP32 wrist pager, cloud Control Plane and QR relay. India only, English only.                                                                                              |

## 02 Problem

Dine-in restaurants still pass paper order slips and shout across the pass. Orders reach the
kitchen slowly and with mistakes, food waits at the pass because the right waiter does not know it
is ready, diners wait for water or the bill, nobody upsells, and owners cannot see who deleted a
bill, gave a discount or sent food that was never billed. That costs covers, average bill and money
lost to leakage (BRD §1.1).

## 03 Goal

Help a restaurant take, cook, serve and bill every order faster and with full accountability, on
its own PC, without depending on the internet.

## 04 Target users

Primary user:

- Who: the restaurant's staff during service: cashier (POS), waiters/captains (phone + pager),
  kitchen (KDS), manager (dashboard); and the diner (table tablet, QR menu, no login).
- Trigger: a restaurant moving off paper KOTs, or off a POS that cannot route orders, page waiters
  or stop bill tampering.
- Today they use: paper KOTs, a basic billing POS, verbal hand-offs.
- They will switch because: every order reaches the right station instantly, the right waiter is
  paged, bills cannot be deleted, and it works when the internet is down.

Secondary users:

- Owner: reports, audit trail, suspicious-activity report, tax and invoice settings, backups
  (password + TOTP).
- Vendor staff (Super Admin, Onboarding, Support, Finance): tenants, licences, releases, fleet
  health in the Control Plane. No standing access to a restaurant's system (AUTH-014).

Not for: chains and multi-outlet groups, delivery or aggregator businesses, bars needing VAT
billing (unless the pilot needs it, OI-03), iOS or macOS users.

## 05 Core features

Each row is done when its BRD exit criteria and scenarios pass. Status is from PROGRESS.md on
2026-10-01.

| #   | Feature                                  | What the user can do                                                                                            | Done when                                                                           | Status                                                                                         |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Local server + POS console               | Open tables, take orders, send KOTs, takeaway tokens, move tables                                               | Phase 1 exit: a simulated service day with correct invoices and audit trail (P1-14) | Built. Windows installer/service (P0-16) not built.                                            |
| 2   | GST billing, payments, day-end           | Bill, discount with limits and manager PIN, split, reprint DUPLICATE, edit/void with approval, shifts, Z-report | BILL-001 to BILL-015 tests pass; S12 fraud patterns attributed                      | Built (P1-10 to P1-12). Digital bills (P7-09) not built.                                       |
| 3   | Kitchen Display System + printing        | See station tickets, mark preparing/ready, bump/recall, notify manager, print ESC/POS KOTs                      | NFR-P01 ≤ 1 s to KDS; S4 printer failure                                            | Built (P1-07, P1-09). Real-printer check is hardware (P0-H4).                                  |
| 4   | Waiter app (Android)                     | My tables, take orders offline-safe, serve, cancel/void, alerts with ack, service-request inbox                 | Phase 2 exit: alert latency and escalation on the lab rig (P2-07)                   | Built except the approvals inbox (P3-03) and upsell prompts (P3-05).                           |
| 5   | Notifications and escalation             | Alerts to the responsible waiter, repeat every R, escalate to manager after N, manager nudge                    | S14 escalation; NFR-P03 ≤ 2 s to pager                                              | Built (P2-03, P2-06). Lab-rig proof (P2-07) needs hardware.                                    |
| 6   | Wrist pager (ESP32)                      | Vibrate + "T7 READY", acknowledge with a button                                                                 | PGR-002 14 h battery gate; S5                                                       | Server side built (P2-04a). Firmware (P2-05), OTA (P2-04b) and battery gate (P0-H1) not built. |
| 7   | Table tablet (Android kiosk)             | Diners browse, search, order for waiter approval, Water/Waiter/Bill/Cancel, see live status                     | Phase 3 exit: S6 tablet session, nothing carried over between sessions              | App shell only. P3-01, P3-02, P3-03, P3-05, P3-06 not built.                                   |
| 8   | Recommendation engine                    | Suggestions with reasons: manual rules, then learned pairs, then best sellers                                   | REC-011 ≤ 200 ms; RPT-012 attach rate                                               | Rules + best sellers built (P3-04). UI (P3-05) and learned pairs (P6-02) not built.            |
| 9   | Manager dashboard and reports            | Live floor and order feed, staff, devices, menu editor, configuration, full reports, exports, audit viewer      | Phase 4 exit: every Must report verified against test data                          | Shell, staff, sections, pagers, core reports built. P4-02c to P4-07 not built.                 |
| 10  | QR online menu + cloud relay             | Diner scans the table QR, orders for waiter approval; read-only when the restaurant is offline                  | Phase 5 exit: S2, S11, S13, duplicate replay                                        | Not built (P5).                                                                                |
| 11  | Vendor Control Plane, licensing, updates | Enrol, heartbeats, tenants, subscriptions, staged licence states, channels, rollout, rollback                   | Phase 7 exit: S8, S9, S10                                                           | Enrolment, signed heartbeats, release channels built (P0-17). Everything in P7 not built.      |
| 12  | Data lifecycle, onboarding               | Backups (local + encrypted cloud), restore, archive-then-purge, setup wizard, menu import                       | S10; new restaurant live in ≤ 1 business day (ONB-009)                              | Excel/CSV menu import built (P1-05). Backup, purge and wizard (P7-05 to P7-07) not built.      |

Key user flow (BRD §5.3 F1 and F4):

1. A waiter opens a table; its tablet unlocks. The diner orders on the tablet (or QR).
2. The responsible waiter is paged and approves in ≤ 2 taps; the KOT splits per station to the
   KDS and printers; the kitchen marks it ready and the pager vibrates "T5 READY".
3. The diner presses Bill; the cashier prints the GST invoice, records the payment mode and closes
   the table; the tablet wipes and resets.

## 06 Success metrics

BRD §2 targets, to be validated in the pilot.

| Metric                                          | Target                            | Measured by         |
| ----------------------------------------------- | --------------------------------- | ------------------- |
| Approved order → visible on KDS                 | ≤ 1 s (p95)                       | System timestamps   |
| Kitchen "Ready" → pager vibrates                | ≤ 2 s (p95)                       | System timestamps   |
| Service request → waiter acknowledgement        | median ≤ 60 s                     | RPT-003             |
| Customer order waiting for approval             | median ≤ 90 s                     | Approval timestamps |
| Ready → picked up                               | ≥ 25 % faster than pilot baseline | RPT-010             |
| Recommendation attach rate                      | ≥ 8 % of tablet/QR orders         | RPT-012             |
| Voids, discounts, reprints attributed           | 100 %                             | Audit log           |
| New restaurant live (≤ 150 items, ≤ 40 tables)  | ≤ 1 business day                  | Onboarding records  |
| Local availability in trading hours             | ≥ 99.9 %                          | Heartbeats          |
| Open Critical/High security findings at go-live | 0                                 | Penetration test    |

## 07 Out of scope

Do not build these in v1 (BRD §3.2), but do not preclude them (BRD §3.3):

- Payment gateway, card terminal or UPI integration; prepayment on QR orders. Payment mode is
  recorded by hand.
- Multi-outlet, central menu, cloud owner dashboard.
- Zomato/Swiggy and other aggregators (keep `source` and `externalRef`/`externalId`).
- Raw-material inventory, recipes, purchasing (only item availability and simple stock counts).
- Loyalty, customer accounts, personalised recommendations (table-level only).
- Delivery; takeaway through QR.
- Languages other than English (strings stay externalised).
- Selling modules separately, third-party POS integration (architecture-ready only, INT-003).
- iOS apps, macOS/Linux desktop. Reservations, attendance/payroll, accounting export, GST e-invoicing.

## 08 Open questions

Open items with their working default. Per the Business Owner's standing instruction (CLAUDE.md),
agents build with the default, put it behind a setting where cheap, and record it in PROGRESS.md
"Decisions" instead of stopping.

- Refund on a voided paid invoice: record mode and amount, and does a manager approve it
  separately? (P1-12b; today no refund is recorded.)
- OI-01 product name, logo and brand colours (default: working title, neutral slate/blue theme).
- OI-03 bar/liquor VAT billing for the pilot (default: excluded).
- OI-04 exact hardware models, OI-05 MDM vendor (block P0-H1 to P0-H4, P3-01 kiosk, P7-04 APK push).
- OI-06 WhatsApp or SMS for digital bills (default: WhatsApp).
- OI-08 grace period and subscription terms (default: 7-day grace), OI-10 backup key escrow policy
  (default: escrow, released on the Owner's authenticated request).
