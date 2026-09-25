import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  isHexColor,
  parseHexColor,
  readableTextColor,
  relativeLuminance,
} from '../src/index.js';

describe('[NFR-U05] colour maths', () => {
  it('parses short and long hex colours', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('#1D4ED8')).toEqual({ r: 29, g: 78, b: 216 });
  });

  it('rejects anything that is not a hex colour', () => {
    for (const bad of ['fff', '#ffff', 'red', 'rgb(0 0 0)', '#ggg']) {
      expect(isHexColor(bad)).toBe(false);
      expect(() => parseHexColor(bad)).toThrow(RangeError);
    }
  });

  it('computes WCAG relative luminance and contrast', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    // Known reference value: #767676 on white is the classic 4.54:1 AA grey.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('picks black or white text, whichever is more readable', () => {
    expect(readableTextColor('#ffffff')).toBe('#000000');
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#facc15')).toBe('#000000');
    expect(readableTextColor('#1d4ed8')).toBe('#ffffff');
  });
});
