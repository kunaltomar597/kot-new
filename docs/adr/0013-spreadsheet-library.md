# ADR-0013: Spreadsheet reading and writing with read-excel-file and write-excel-file

Status: Accepted
Date: 2026-09-26
Work package: P1-05
Requirements: ONB-005, ONB-009, SEC-004, NFR-M07

## Context

The menu import (P1-05) reads the vendor's Excel template, and the server writes that template.
Later reports (P4, RPT-017) will also export Excel. The BRD names ExcelJS as an example for XLSX
generation, and the P1-05 spec named it for reading too.

ExcelJS 4.4 (its latest release) pulls `unzipper` 0.10, which brings `buffers` (no licence
declared) and `chainsaw` and `traverse` (MIT/X11). None of these is on the licence allow-list
(NFR-M07). It also pulls an old `uuid` with a moderate advisory. The package has not had a
release in a long time.

## Decision

- Read .xlsx with `read-excel-file` and write it with `write-excel-file`. Both are MIT, and their
  only runtime dependencies are `fflate` (MIT) and `@xmldom/xmldom` (MIT).
- The server converts cells to the text a person typed (`workbook.ts` `cellText`); all
  validation is in `@rp/domain` `planMenuImport`, which works on text rows. The CSV path uses the
  same planner through `parseCsv`.
- Before a workbook is decompressed, its ZIP central directory is checked (`zip-limits.ts`: at
  most 20 MB per entry and 60 MB in total, no ZIP64) so that a small upload cannot expand into
  gigabytes (SEC-004).

## Alternatives considered

- ExcelJS with licence exceptions for the unzipper chain: this adds unreviewed licences and a
  vulnerable dependency to the product for no extra feature we need.
- SheetJS: the npm release is old and has advisories; newer builds are only on its own CDN,
  outside our registry and audit.
- Writing our own XLSX reader on top of `fflate`: more code to own, for no benefit over a small,
  maintained library.

## Consequences

- The template has plain formatting only: bold headers, an italic notes row, column widths and
  frozen header rows. That is enough for the template.
- Report exports in Excel (P4) use `write-excel-file` too. If they need charts or rich styling,
  revisit this ADR.
