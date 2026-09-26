import { describe, expect, it } from 'vitest';
import { gstSummary, lineTaxShares } from '../src/reports.js';

describe('[RPT-002] tax per line', () => {
  it('spreads each group’s tax over its lines by taxable value, adding up exactly', () => {
    const shares = lineTaxShares(
      [
        { lineId: 'tikka', taxGroupId: 'gst5', taxableValue: 56_000 },
        { lineId: 'lassi', taxGroupId: 'gst5', taxableValue: 8_001 },
        { lineId: 'comp', taxGroupId: 'gst5', taxableValue: 0 },
        { lineId: 'water', taxGroupId: 'gst18', taxableValue: 2_000 },
      ],
      [
        { taxGroupId: 'gst5', amount: 1_600 },
        { taxGroupId: 'gst5', amount: 1_600 },
        { taxGroupId: 'gst18', amount: 360 },
      ],
    );
    expect(shares.get('water')).toBe(360);
    expect(shares.get('comp')).toBe(0);
    expect((shares.get('tikka') ?? 0) + (shares.get('lassi') ?? 0)).toBe(3_200);
  });

  it('gives no tax to lines of an untaxed group or with nothing taxable', () => {
    const shares = lineTaxShares([{ lineId: 'a', taxGroupId: null, taxableValue: 100 }], []);
    expect(shares.get('a')).toBe(0);
  });
});

describe('[RPT-006] GST summary', () => {
  it('adds up taxable value and each component by SAC and combined rate', () => {
    const cgst = (rateBp: number, amount: number) => [
      { code: 'CGST', rateBp, amount },
      { code: 'SGST', rateBp, amount },
    ];
    const rows = gstSummary([
      { sacCode: '996331', taxableValue: 56_000, components: cgst(250, 1_400) },
      { sacCode: '996331', taxableValue: 8_000, components: cgst(250, 200) },
      { sacCode: '996332', taxableValue: 2_000, components: cgst(900, 180) },
      { sacCode: null, taxableValue: 1_000, components: cgst(250, 25) },
    ]);
    expect(rows).toEqual([
      {
        sacCode: null,
        rateBp: 500,
        taxableValue: 1_000,
        components: { CGST: 25, SGST: 25 },
        taxTotal: 50,
      },
      {
        sacCode: '996331',
        rateBp: 500,
        taxableValue: 64_000,
        components: { CGST: 1_600, SGST: 1_600 },
        taxTotal: 3_200,
      },
      {
        sacCode: '996332',
        rateBp: 1_800,
        taxableValue: 2_000,
        components: { CGST: 180, SGST: 180 },
        taxTotal: 360,
      },
    ]);
  });
});
