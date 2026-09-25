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
