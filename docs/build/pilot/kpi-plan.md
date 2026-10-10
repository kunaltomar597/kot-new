# Pilot KPI measurement plan and feedback loop (P8-06)

BRD §2 sets the targets. They are proposals the pilot validates. This plan says where each number
comes from, who reads it and when.

## 1. What is measured, and from where

| KPI                                      | Target                        | Source in the product                                             | Status                   |
| ---------------------------------------- | ----------------------------- | ----------------------------------------------------------------- | ------------------------ |
| Approved order to visible on KDS         | p95 ≤ 1 s                     | Server timestamps; `pnpm --filter @rp/server test:perf` on the PC | Measured by the load run |
| Ready to pager vibrates                  | p95 ≤ 2 s                     | Pager heartbeat and ack timestamps; lab rig (task 16)             | Needs the rig            |
| Service request to acknowledgement       | median ≤ 60 s                 | Staff report, RPT-003                                             | In the product           |
| Ready to picked up                       | 25 % lower than the baseline  | Kitchen performance report, RPT-010                               | In the product           |
| Customer order waiting for approval      | median ≤ 90 s (risk R-04)     | Approval timestamps on orders                                     | Report to build (P8-06b) |
| Recommendation attach rate               | ≥ 8 % of tablet and QR orders | Recommendation report, RPT-012                                    | In the product           |
| Voids, discounts, reprints with a person | 100 %                         | Audit log; the suspicious-activity report (RPT-014)               | In the product           |
| New restaurant live                      | ≤ 1 business day              | Onboarding records, timing in `docs/build/onboarding-timing.md`   | Recorded at install      |
| Local availability in trading hours      | ≥ 99.9 %                      | Heartbeat history in the Control Plane; the System page           | Needs a monthly view     |

## 2. Rhythm

- Daily during week 1, then weekly: the manager and the vendor's support lead read the reports
  above for the week and log them in the table in section 4.
- Weekly: the Business Owner reviews with the vendor and decides which defects to fix first.
- End of the pilot (at least 4 weeks): the KPI table, the defect list and the feedback log go into
  the commercial launch review (BRD §18.3).

## 3. Baselines

Before go-live the Business Owner measures, with a stopwatch and the old process, over at least
three services: ready-to-picked-up time, service-request-to-response time, and the time a customer
order waits for a waiter. Enter them in section 4. Without them the "25 % reduction" cannot be
judged.

## 4. Results (copy one row per week)

| Week | Approval median | Ack median | Ready to pickup | Attach rate | Availability | Sev-1 | Sev-2 |
| ---- | --------------- | ---------- | --------------- | ----------- | ------------ | ----- | ----- |
| Base |                 |            |                 | n/a         | n/a          |       |       |
| 1    |                 |            |                 |             |              |       |       |

## 5. Feedback loop

1. Staff report problems to the manager, who logs each in the feedback form (P3-05b) or, for
   trouble with the system, "Send diagnostics" on the System page.
2. The vendor triages within one working day: Sev-1 and Sev-2 (BRD §18.3) go to the incident
   process (`docs/security/incident-response.md`, `docs/runbooks/support-playbook.md`).
3. Each fix goes through the normal work-package loop and ships as a signed update in the
   maintenance window (`docs/runbooks/software-updates.md`).
4. Every Friday the vendor tells the manager what was fixed, what is next and what was declined,
   with the reason.
