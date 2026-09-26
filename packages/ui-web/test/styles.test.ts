// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesDir = new URL('../src/styles/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, stylesDir), 'utf8');
const all = readdirSync(stylesDir)
  .filter((file) => file.endsWith('.css'))
  .map((file) => ({ file, css: read(file) }));

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[1]!;
}

describe('[NFR-U01] stylesheet', () => {
  it('imports every component stylesheet into a cascade layer', () => {
    const index = read('index.css');
    expect(index).toContain('@layer rp.tokens, rp.base, rp.components;');
    for (const { file } of all.filter(({ file }) => file !== 'index.css')) {
      expect(index).toMatch(new RegExp(`@import url\\('./${file}'\\) layer\\(rp\\.`));
    }
  });

  it('uses design tokens instead of ad-hoc colours', () => {
    for (const { file, css } of all) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(withoutComments, file).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    }
  });
});

describe('[NFR-U03] [KDS-011] touch targets', () => {
  // The KDS theme raises --rp-touch-target to 64 px, so every control grows with it.
  const interactive: [string, string, string][] = [
    ['button.css', '.rp-button', 'min-height: var(--rp-touch-target)'],
    ['button.css', '.rp-button', 'min-width: var(--rp-touch-target)'],
    ['button.css', '.rp-icon-button', 'width: var(--rp-touch-target)'],
    ['keypad.css', '.rp-keypad__key', 'min-height: calc(var(--rp-touch-target) * 1.25)'],
    ['field.css', '.rp-field__input', 'min-height: var(--rp-touch-target)'],
    ['tabs.css', '.rp-tabs__tab', 'min-height: var(--rp-touch-target)'],
    ['toast.css', '.rp-toast__action', 'min-height: var(--rp-touch-target)'],
    ['table.css', '.rp-table th,\n.rp-table td', 'height: var(--rp-touch-target)'],
    ['table-tile.css', '.rp-table-tile', 'min-height: calc(var(--rp-touch-target) * 2)'],
  ];

  it.each(interactive)('%s %s is at least the touch target', (file, selector, declaration) => {
    expect(rule(read(file), selector)).toContain(declaration);
  });

  it('removes the tap delay on touch screens', () => {
    expect(rule(read('button.css'), '.rp-button')).toContain('touch-action: manipulation');
    expect(rule(read('keypad.css'), '.rp-keypad__key')).toContain('touch-action: manipulation');
    expect(rule(read('table-tile.css'), '.rp-table-tile')).toContain('touch-action: manipulation');
  });
});
