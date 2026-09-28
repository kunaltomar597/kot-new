import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

/** The dark modules the SVG path draws, as "x,y" keys, and the code's width in modules. */
function drawn(svg: Element): { modules: number; dark: Set<string> } {
  const modules = Number(svg.getAttribute('data-modules'));
  const path = svg.querySelector('path')?.getAttribute('d') ?? '';
  const dark = new Set([...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([, x, y]) => `${x},${y}`));
  return { modules, dark };
}

/** A finder pattern: a dark 7×7 ring, a light ring inside it and a dark 3×3 centre. */
function isFinderAt(dark: Set<string>, left: number, top: number): boolean {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      const shouldBeDark = ring !== 2;
      if (dark.has(`${String(left + x)},${String(top + y)}`) !== shouldBeDark) return false;
    }
  }
  return true;
}

describe('[AUTH-006] [AUTH-007] QrCode', () => {
  it('draws a readable code: three finder patterns inside a clear four-module border', async () => {
    const { container } = renderUi(<QrCode value="RP" label="Test code" />);
    const svg = screen.getByRole('img', { name: 'Test code' });
    const { modules, dark } = drawn(svg);
    // Version 1 is 21 modules wide, plus the quiet zone on both sides.
    expect(modules).toBe(29);
    expect(isFinderAt(dark, 4, 4)).toBe(true);
    expect(isFinderAt(dark, modules - 11, 4)).toBe(true);
    expect(isFinderAt(dark, 4, modules - 11)).toBe(true);
    for (const key of dark) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      expect(Math.min(x, y)).toBeGreaterThanOrEqual(4);
      expect(Math.max(x, y)).toBeLessThan(modules - 4);
    }
    expect(svg.querySelector('rect')).toHaveAttribute('fill', '#ffffff');
    await expectNoAxeViolations(container);
  });

  it('grows with the text and changes when the text does', () => {
    const uri =
      'otpauth://totp/Spice%20Route:Asha?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Spice%20Route&algorithm=SHA1&digits=6&period=30';
    const { rerender } = renderUi(<QrCode value={uri} label="Authenticator" size={240} />);
    const svg = screen.getByRole('img', { name: 'Authenticator' });
    const first = drawn(svg);
    expect(first.modules).toBeGreaterThan(29);
    expect(svg).toHaveAttribute('width', '240');
    rerender(<QrCode value={uri.replace('Asha', 'Kunal')} label="Authenticator" size={240} />);
    const second = drawn(screen.getByRole('img', { name: 'Authenticator' }));
    expect([...second.dark].sort()).not.toEqual([...first.dark].sort());
  });
});
