import { describe, expect, it } from 'vitest';
import { effectivePrinterId } from '../../src/printing/printer-status.service.js';

const printers = new Map([
  ['kitchen', { id: 'kitchen', archivedAt: null, redirectToId: null }],
  ['broken', { id: 'broken', archivedAt: null, redirectToId: 'kitchen' }],
  ['gone', { id: 'gone', archivedAt: new Date(), redirectToId: null }],
  ['toGone', { id: 'toGone', archivedAt: null, redirectToId: 'gone' }],
]);

const station = (mode: 'SCREEN' | 'PRINT' | 'BOTH', printerId: string | null) => ({
  id: 's',
  mode,
  printerId,
});

describe('[KDS-008] where a station prints', () => {
  it('prints on its own printer', () => {
    expect(effectivePrinterId(station('BOTH', 'kitchen'), printers)).toBe('kitchen');
    expect(effectivePrinterId(station('PRINT', 'kitchen'), printers)).toBe('kitchen');
  });

  it('prints nothing on screen only, without a printer, or with an archived one', () => {
    expect(effectivePrinterId(station('SCREEN', 'kitchen'), printers)).toBeNull();
    expect(effectivePrinterId(station('BOTH', null), printers)).toBeNull();
    expect(effectivePrinterId(station('BOTH', 'gone'), printers)).toBeNull();
    expect(effectivePrinterId(station('BOTH', 'unknown'), printers)).toBeNull();
  });

  it('follows a redirect to an active printer, and ignores one to an archived printer', () => {
    expect(effectivePrinterId(station('BOTH', 'broken'), printers)).toBe('kitchen');
    expect(effectivePrinterId(station('BOTH', 'toGone'), printers)).toBe('toGone');
  });
});
