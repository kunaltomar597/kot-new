import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { uiTextRestrictions } from '../../config/eslint/ui-text.mjs';

const linter = new Linter({ configType: 'flat' });

function problems(code: string): number {
  return linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'no-restricted-syntax': ['error', ...uiTextRestrictions] },
      },
    ],
    'screen.tsx',
  ).length;
}

describe('[NFR-L02] lint rule: no UI text literals in JSX', () => {
  it.each([
    ['text children', 'const a = <p>Sign in</p>;'],
    ['a string child', "const a = <p>{'Sign in'}</p>;"],
    ['a template child', 'const a = <p>{`Hello ${name}`}</p>;'],
    ['a fragment child', "const a = <>{'Sign in'}</>;"],
    ['a text prop', 'const a = <Button label="Save" />;'],
    ['an aria-label', 'const a = <button aria-label="Close" />;'],
    ['a braced text prop', "const a = <input placeholder={'Search'} />;"],
    ['a template text prop', 'const a = <img alt={`Photo of ${name}`} />;'],
    ['non-Latin text', 'const a = <p>नमस्ते</p>;'],
  ])('flags %s', (_case, code) => {
    expect(problems(code)).toBe(1);
  });

  it.each([
    ['translated text', "const a = <p>{t('login.title')}</p>;"],
    ['a translated prop', "const a = <Button label={t('states.retry')} />;"],
    ['class names and ids', 'const a = <div className="stack" id="main" data-testid="x" />;'],
    ['punctuation and numbers', 'const a = <p>{count} · {total} – 2</p>;'],
    ['variants', 'const a = <Button variant="primary" size="large" />;'],
  ])('allows %s', (_case, code) => {
    expect(problems(code)).toBe(0);
  });
});
