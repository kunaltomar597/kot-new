import { allocate, sum, type Paise } from './money.js';

/** An invoice line as reports need it (the invoice's current version). */
export interface ReportLine {
  readonly lineId: string;
  readonly taxGroupId: string | null;
  readonly taxableValue: Paise;
}

/** A tax line of the same invoice and version. */
export interface ReportTaxLine {
  readonly taxGroupId: string;
  readonly amount: Paise;
}

/**
 * Tax per invoice line, for item-wise reports (RPT-002). Invoices carry tax per group (ADR-0003),
 * not per line; each group's tax is spread over its lines in proportion to their taxable value,
 * so the lines of an invoice add up exactly to its tax.
 */
export function lineTaxShares(
  lines: readonly ReportLine[],
  taxLines: readonly ReportTaxLine[],
): Map<string, Paise> {
  const shares = new Map<string, Paise>();
  const groups = new Map<string, ReportLine[]>();
  for (const line of lines) {
    shares.set(line.lineId, 0);
    if (line.taxGroupId !== null) {
      groups.set(line.taxGroupId, [...(groups.get(line.taxGroupId) ?? []), line]);
    }
  }
  for (const [groupId, groupLines] of groups) {
    const tax = sum(
      taxLines.filter((line) => line.taxGroupId === groupId).map((line) => line.amount),
    );
    const weights = groupLines.map((line) => line.taxableValue);
    if (tax === 0 || sum(weights) === 0) continue;
    allocate(tax, weights).forEach((share, index) => {
      const line = groupLines[index];
      if (line !== undefined) shares.set(line.lineId, share);
    });
  }
  return shares;
}

/** One taxed amount of an invoice: a tax group's components on one taxable value. */
export interface GstCluster {
  readonly sacCode: string | null;
  readonly taxableValue: Paise;
  readonly components: readonly {
    readonly code: string;
    readonly rateBp: number;
    readonly amount: Paise;
  }[];
}

export interface GstSummaryRow {
  readonly sacCode: string | null;
  /** The combined rate, e.g. 500 for CGST 2.5 % + SGST 2.5 %. */
  readonly rateBp: number;
  readonly taxableValue: Paise;
  /** Amount per component code, e.g. { CGST: 1250, SGST: 1250 }. */
  readonly components: Readonly<Record<string, Paise>>;
  readonly taxTotal: Paise;
}

/**
 * The GST tax summary for the restaurant's CA (RPT-006): taxable value and each component by SAC
 * code and rate, over non-voided invoices. Rows are ordered by SAC, then rate.
 */
export function gstSummary(clusters: readonly GstCluster[]): GstSummaryRow[] {
  const rows = new Map<
    string,
    {
      sacCode: string | null;
      rateBp: number;
      taxableValue: number;
      components: Record<string, number>;
    }
  >();
  for (const cluster of clusters) {
    const rateBp = sum(cluster.components.map((component) => component.rateBp));
    const key = `${cluster.sacCode ?? ''}|${String(rateBp)}`;
    const row = rows.get(key) ?? {
      sacCode: cluster.sacCode,
      rateBp,
      taxableValue: 0,
      components: {},
    };
    row.taxableValue += cluster.taxableValue;
    for (const component of cluster.components) {
      row.components[component.code] = (row.components[component.code] ?? 0) + component.amount;
    }
    rows.set(key, row);
  }
  return [...rows.values()]
    .sort((a, b) => (a.sacCode ?? '').localeCompare(b.sacCode ?? '') || a.rateBp - b.rateBp)
    .map((row) => ({ ...row, taxTotal: sum(Object.values(row.components)) }));
}
