# Phase 8: Hardening and pilot

BRD §17 Phase 8 and §18. Exit criteria: §18 acceptance met (S1 to S14 pass, no open Sev-1/Sev-2,
penetration test with no open Critical/High findings), pilot KPIs measured, pilot of 1 to 2
restaurants for at least 4 weeks.

---

## P8-01 Load and capacity tests

Requirements: BRD §7.1 (NFR-P01 to NFR-P12), §7.2 capacity, S1, DATA-012, RPT-018.
Deliverables: k6 (or similar) scenarios simulating 100 tables, 60 tablets, 30 pagers, 20 waiter
devices, 6 KDS, 8 printers, 2,000 orders/day with a 300/hour peak and 200 concurrent real-time
connections; simulated MQTT pagers; a generated 5-year dataset for report and sizing tests; a report
of p95 figures against every NFR-P target. S1 dinner rush on the lab rig with real devices.
Acceptance: all targets met or tickets raised with fixes.

## P8-02 Failure drills

Requirements: S2 to S5, S7, S14, NFR-A01 to NFR-A04, §7.3 failure table.
Deliverables: scripted drills for internet outage, server restart mid-service, printer failure, pager
out of range/battery dead, move table with tickets in progress, escalation; power-cut recovery on the
lab PC; results recorded.
Acceptance: every drill passes; no lost or duplicate orders/KOTs.

## P8-03 Security hardening and penetration-test readiness

Requirements: SEC-000 to SEC-019, BRD §8.1 standards, SEC-016 (incident response), SEC-017.
Deliverables: STRIDE threat model per component (LAN, pager channel, relay, update pipeline, licence
mechanism) in `docs/security/`; OWASP ASVS L2 and MASVS checklists with evidence links; DAST on the
QR site, relay and Control Plane; Electron hardening review; MDM policy document; incident response
plan with CERT-In 6-hour reporting and DPDP breach notifications; fixes for all findings; support for
the external penetration test.
People needed: Business Owner engages a CERT-In empanelled testing firm.
Acceptance: zero open Critical/High; Medium findings with dated remediation plans.

## P8-04 UX polish and accessibility audit

Requirements: NFR-U01 to NFR-U07, KDS-011, TAB-016.
Deliverables: audit of every screen for empty, loading and error states and plain-language errors;
touch targets; WCAG 2.2 AA audit of QR menu and dashboard; usability test scripts for 5 users per
role (waiter proficient ≤ 30 min, diner first order ≤ 2 min, split bill ≤ 1 min); contextual help (S).
Acceptance: audit issues closed; usability results recorded.

## P8-05 Runbooks, manuals and training material

Requirements: NFR-M06, NFR-U07, BRD §19.3 (manuals, training videos approved by the Business Owner).
Deliverables in `docs/runbooks/` and `docs/manuals/`: installation, restore, update, rollback,
incident response, support playbook, developer onboarding guide; user manuals per role; scripts for
training videos.
Acceptance: Business Owner review.

## P8-06 Pilot readiness

Requirements: BRD §18.3 acceptance, §2 KPIs, R-04 (approval time), R-06.
Deliverables: `pnpm trace --strict` passes (every Must requirement linked to a passing test); UAT
plan and results; go-live checklist; KPI measurement plan and dashboards for the pilot (approval
time, ack time, ready-to-pickup, attach rate, availability); pilot feedback loop.
Acceptance: pilot entry criteria met and signed off by the Business Owner.
