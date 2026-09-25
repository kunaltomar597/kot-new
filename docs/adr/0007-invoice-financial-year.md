# ADR-0007: Financial year used for invoice numbering

Status: Accepted (decided 2026-09-25; the pilot CA reviews invoice templates during onboarding)
Date: 2026-09-25
Work package: P0-04
Requirements: BILL-003, BRD §9.4 (business date), §12 (GST invoicing)

## Context

Invoice numbers must be unique and consecutive within a financial year (1 April to 31 March). The
platform also uses a business date with a 04:00 cut-off, so a bill printed at 01:00 on 1 April has
business date 31 March.

## Decision

The financial year of an invoice follows the calendar date of issue in IST (the legal invoice date),
not the business date. The invoice still records its business date for operational reports.

## Consequences

On the night of 31 March the invoice series may switch to the new year mid-service; Z-reports for
business date 31 March may therefore contain invoices from two financial years. GST reports (RPT-006)
filter by invoice date. If the CA prefers the business date, change the rule in the billing module
(P1-10); `@rp/domain` `financialYearOf` accepts either date.
