# Phase 6: Advanced menu and intelligence

BRD §17 Phase 6. Exit criteria: the same combo + modifier order succeeds on every surface (the
blueprint's "week 30" test).

---

## P6-01 Combo and modifier parity on every surface

Requirements: MENU-004, MENU-005, MENU-012, ORD-007.
Depends on: P1-08, P2-02, P3-03, P5-05.
Deliverables: finish combo choice-slot selection and time-window availability on POS, waiter app,
tablet and QR using shared components and `@rp/domain` logic (add combo slot validation to the
domain package if not already there); a cross-surface test that places the same combo + modifier
order on all four surfaces and asserts identical server-side lines, prices and KOT output.
Acceptance: the cross-surface test passes.

## P6-02 Learned recommendations

Requirements: REC-003, REC-005, REC-008, QR-004 (learned pairings in snapshot), NFR-P09.
Depends on: P3-04, P5-03.
Deliverables: association-rule mining (FP-Growth or co-occurrence with lift) in `packages/domain`
over a rolling 90-day window of the restaurant's own orders; thresholds for support, confidence and
lift; activation after 300 orders; nightly job on the local server; results stored as
LearnedAssociation and published in the relay snapshot; layer precedence rules → learned → best
sellers.
Acceptance: unit tests on synthetic baskets with known associations; job runtime acceptable at
design capacity; no suggestions below the activation volume.

P3-04 left the place for this: `recommend` takes `learned` pairs (`fromItemId`, `toItemId`,
`score`) as its second layer, after the rules and before the best sellers, with the same filters;
`RecommendationsService` passes none yet. Its reason is `{ kind: 'LEARNED', becauseOf }`, shown as
"Often ordered with …".

## P6-03 Voice search

Requirements: TAB-007 (S), ONB-011 (offline speech pack checklist), risk R-09.
Depends on: P3-03.
Deliverables: microphone button using Android on-device SpeechRecognizer through an actively
maintained module (check `expo-speech-recognition` maintenance first; record choice in an ADR);
recognised text fed into the fuzzy search; clear fallback when recognition is unavailable.
People needed: test on the tablet with and without the offline English pack.
Acceptance: works on device; unavailable state handled.

## P6-04 AI-assisted menu import

Requirements: ONB-006 (S), ONB-007 (S), VCP-008, SEC-002 (AI key only in the vendor cloud).
Depends on: P0-17, P1-05.
Deliverables: Control Plane service that accepts photos/PDF of a printed menu, calls the AI provider
(key held only in the Control Plane secret store) to extract items into the P1-05 template structure,
returns a draft; mandatory human review screen in the console showing every item before commit;
bulk photo upload matched by file name or item code with manual correction.
Acceptance: pipeline test with a fixture menu (provider call mocked in CI); review screen blocks
commit until reviewed.

Split in three (2026-10-02):

- **P6-04a Control Plane reading service.** Signed job API (`/v1/menu-extractions`), files held
  only until read, a worker calling the AI provider (Anthropic Messages API, forced tool call) with
  the key from the Control Plane's secret store, retries, a daily limit per restaurant, audit; the
  provider mocked in CI.
- **P6-04b Review and import on the restaurant PC.** The local server sends the photos (resized
  first) to the Control Plane and fetches the draft; the console's review screen shows every dish,
  lets the manager correct it and set what a printed menu cannot say (tax group, station), blocks
  the import until each dish is checked, then imports through the P1-05 template path.
- **P6-04c Bulk photo upload (ONB-007).** Many photos at once, matched to dishes by file name or
  short code, with a table to correct the matches before upload.

## P6-05 Should-have operations batch

Requirements: ORD-016 (hold and fire), TBL-006 (merge tables, transfer items), MENU-007
(time-based availability), KDS-002 (Expo/Pass view), KDS-010 (all-day summary), WTR-013 (takeaway
from waiter app), WTR-008 (print bill from app), TBL-004 ("Needs cleaning"), BILL-001 (amount in
words), BILL-013 (denomination count), ONB-004 step 5 (drag-and-drop floor layout), ONB-004 step 6
(printer auto-discovery), NTF-009 (on break), KDS-006 (automatic escalation).
Depends on: Phase 1 to 3 WPs for each feature.
Notes: split into P6-05a, P6-05b, ... per feature group when started. Each feature ships behind a
setting where it changes workflow.
Acceptance: per feature, tests and a short PROGRESS.md entry.

Split (2026-10-02), after a survey of what P1 to P5 already built (KDS-010 was done):

- **P6-05a Finishing what was half built.** Kitchen screens with one or more stations and the
  Expo/Pass view (KDS-002, the M part too), automatic escalation of uncollected food (KDS-006),
  "On break" in the waiter app (NTF-009), the denomination count at shift close (BILL-013).
- **P6-05b Hold and fire** (ORD-016).
- **P6-05c Ordering.** Takeaway from the waiter app (WTR-013), time-based item availability
  (MENU-007). Done: per-dish daily hours, checked like a combo's hours on every surface.
- **P6-05d Tables.** Merge tables and transfer items (TBL-006), "Needs cleaning" (TBL-004).
  Done: merge closes the joining table's session; dishes move as whole lines; cleaning is a
  setting, off by default.
- **P6-05e Billing.** Amount in words (BILL-001), print the bill from the waiter app (WTR-008).
  Done: printing from the app is a setting, off by default (the §4.2 matrix does not allow it).
- **P6-05f Setup.** Drag-and-drop floor layout (ONB-004 step 5), printer auto-discovery (step 6).
