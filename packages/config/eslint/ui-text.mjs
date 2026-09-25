// NFR-L02: UI text comes from @rp/i18n (t()), never from string literals in JSX. Used by the root
// eslint.config.mjs for UI source files, and tested in packages/i18n/test/ui-text-rule.test.ts.

const MESSAGE = 'UI text must come from @rp/i18n (t()), not a literal in JSX (NFR-L02).';

/** Props that carry text a person reads or a screen reader announces. */
export const TEXT_PROPS = [
  'label',
  'title',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'description',
  'hint',
  'error',
  'heading',
  'message',
];

const LETTER = '/\\p{L}/u';
const TEXT_PROP = `JSXAttribute[name.name=/^(${TEXT_PROPS.join('|')})$/]`;

/** Selectors for `no-restricted-syntax`: text children and text props that contain letters. */
export const uiTextRestrictions = [
  `JSXText[value=${LETTER}]`,
  `JSXElement > JSXExpressionContainer > Literal[value=${LETTER}]`,
  `JSXFragment > JSXExpressionContainer > Literal[value=${LETTER}]`,
  `JSXElement > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=${LETTER}]`,
  `${TEXT_PROP} > Literal[value=${LETTER}]`,
  `${TEXT_PROP} > JSXExpressionContainer > Literal[value=${LETTER}]`,
  `${TEXT_PROP} > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=${LETTER}]`,
].map((selector) => ({ selector, message: MESSAGE }));
