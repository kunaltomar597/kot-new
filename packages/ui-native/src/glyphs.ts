/**
 * Small symbols drawn with text so the library needs no icon font or SVG dependency. They are
 * decoration only: every one sits next to words, so colour or shape is never the only signal
 * (NFR-U05), and screen readers skip them.
 */
export const GLYPHS = {
  check: '✓',
  checkDouble: '✓✓',
  clock: '◷',
  send: '➤',
  flame: '▲',
  handPlatter: '◉',
  xCircle: '✕',
  ban: '⊘',
  info: 'i',
  warning: '!',
  error: '!',
  minus: '−',
  plus: '+',
  backspace: '⌫',
  close: '✕',
  radioOn: '◉',
  radioOff: '○',
  boxOn: '☑',
  boxOff: '☐',
} as const;

export type GlyphName = keyof typeof GLYPHS;
