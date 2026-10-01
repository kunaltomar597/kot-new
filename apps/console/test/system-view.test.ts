import { describe, expect, it } from 'vitest';
import { bytesParts, uptimeParts } from '../src/manage/system/system-view.js';

describe('[DATA-006] [NFR-I03] sizes and times on the System page', () => {
  it('shows sizes in the units Windows uses', () => {
    expect(bytesParts(512)).toEqual({ value: '512', unit: 'B' });
    expect(bytesParts(1_536)).toEqual({ value: '1.5', unit: 'KB' });
    expect(bytesParts(42 * 1_024 ** 2)).toEqual({ value: '42', unit: 'MB' });
    expect(bytesParts(4 * 1_024 ** 3)).toEqual({ value: '4', unit: 'GB' });
    expect(bytesParts(256 * 1_024 ** 3)).toEqual({ value: '256', unit: 'GB' });
    expect(bytesParts(3 * 1_024 ** 5)).toEqual({ value: '3072', unit: 'TB' });
  });

  it('says how long the server has run', () => {
    expect(uptimeParts(59)).toEqual({ kind: 'minutes', minutes: 0 });
    expect(uptimeParts(3_725)).toEqual({ kind: 'hours', hours: 1, minutes: 2 });
    expect(uptimeParts(2 * 86_400 + 3 * 3_600)).toEqual({ kind: 'days', days: 2, hours: 3 });
  });
});
