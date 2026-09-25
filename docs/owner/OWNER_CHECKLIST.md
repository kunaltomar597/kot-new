# Business Owner checklist (Track 3)

From BRD §19. These are things only the Business Owner (Kunal and Kshitij) can arrange. The
"Needed by" column says which work package is blocked without it. Tick items here as they are done
and tell Claude in a session so it can update PROGRESS.md.

Never paste secrets, keys or passwords into a Claude session or commit them. Give the development
lead controlled access to the accounts instead (SEC-002).

## Start this week (long lead times or blocks Phase 0)

- [ ] 1. Company-owned GitHub organisation (paid plan) with 2FA enforced; move this repository there;
      protect `main`. Needed by: now.
- [ ] 2. Domain name(s) and DNS provider (QR site, Control Plane, update server). Needed by: P0-15, P0-17.
- [ ] 3. Windows code-signing certificate (OV or EV) in the company name, key on a hardware token or
      cloud HSM. Verification can take weeks. Needed by: P0-16 (signed installer), P7-04.
- [ ] 4. Cloud KMS / secrets manager (licence-signing key, backup-key escrow, CI secrets). Needed by: P0-17, P7-01.
- [ ] 5. Cloud hosting in India (AWS/GCP/Azure Mumbai, or Vercel + managed Postgres) for the Control
      Plane, update distribution and QR site. Needed by: P0-17 (minimal), P5, P7.
- [ ] Buy the lab rig: Windows 11 PC (16 GB RAM, second drive), 2 table tablets (the chosen model),
      2 Android phones, 1 KDS tablet or TV box, 2 thermal printers (80 mm Ethernet + one USB/58 mm),
      4 LilyGO T-Watch S3 (or chosen ESP32 watch) + charging, business router with separate SSIDs/VLANs,
      UPS. Needed by: P0-H1 to P0-H4, P0-16, P2-07.
- [ ] Approve the supported-hardware list (OI-04). Needed by: Phase 0 end.
- [ ] Sign off the BRD, including the "Decisions awaiting confirmation" in `docs/build/PROGRESS.md`
      and OI-13. Name one product decision-maker for day-to-day questions.

## Needed during Phases 1 to 3

- [ ] 6. Error-monitoring service (Sentry or equivalent). Needed by: P7-08 (interface exists from P0-07).
- [ ] 7. Expo account (paid plan sized for builds and OTA). Needed by: P2-01.
- [ ] 8. Android app-signing keystore under company ownership, backed up in a secure vault. Losing it
      means installed apps can never be updated. Needed by: P2-01.
- [ ] 9. MDM subscription for tablets and phones (OI-05 vendor choice). Needed by: P0-H3, P3-01.
- [ ] Decide OI-03 (bar/liquor VAT billing for the pilot?) before Phase 1, and OI-11/OI-12 (kitchen
      may mark out of stock: default yes; service charge default: off).
- [ ] Recruit the pilot restaurant(s), sign pilot agreements, and measure baseline KPIs (§2) before
      go-live.
- [ ] Ask the pilot restaurant's CA to confirm: invoice template, tax rates, SAC code, service charge
      taxation (ADR-0003), financial year rule (ADR-0007), e-invoicing applicability.

## Needed for Phases 5 to 7

- [ ] 10. Supabase organisation: dev/staging/prod projects, paid plan for production, Mumbai region.
      Needed by: P5-01.
- [ ] 11. Backup storage (S3-compatible, India region). Needed by: P7-05.
- [ ] 12. AI provider API account (key stored only in the Control Plane). Needed by: P6-04.
- [ ] 13. SMS provider with TRAI DLT registration and/or WhatsApp Business Platform provider. Needed by: P7-09.
- [ ] 14. Transactional e-mail service. Needed by: P7-02.
- [ ] 15. Payment gateway merchant account (only if automating subscription collection). Needed by: P7-02 (S).
- [ ] Decide pricing and plans; grace period and overdue thresholds (OI-08); backup key-escrow policy
      (OI-10).

## Legal, compliance and commercial (§19.2)

- [ ] Company incorporation and GST registration; how subscriptions will be invoiced.
- [ ] Subscription agreement / EULA (plans, payment terms, licence states and timelines matching
      LIC-005 exactly, data ownership and export, support hours and SLA, liability, termination and data
      return).
- [ ] Data Processing Agreement (restaurant = data fiduciary, vendor = processor); vendor privacy
      policy; diner privacy notice for tablet and QR menu; consent wording.
- [ ] DPDP compliance review with counsel (Rules phase-in ends around the launch window).
- [ ] CERT-In point of contact and ownership of the incident-response plan (SEC-016).
- [ ] Product name and trademark (OI-01). The code uses the neutral scope `@rp/` until then.
- [ ] Sign off open-source licence compliance (report produced by P0-06).
- [ ] Pager certification via a compliance consultant (WPC ETA, BIS CRS applicability, battery
      safety). Start early (R-14).
- [ ] Engage a penetration-testing firm (CERT-In empanelled advisable). Needed by: P8-03.
- [ ] Cyber and product-liability insurance (recommended).

## Operations (§19.3)

- [ ] Onboarding and support team: support hours, phone/WhatsApp line, escalation path, SLAs, who
      answers at 9 pm on a Saturday.
- [ ] Approve the Excel menu template (P1-05), training videos and user manuals (P8-05).
- [ ] Name the release approval authority for production rollouts (P7-04).
