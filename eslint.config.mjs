// Root ESLint flat config shared by every TypeScript package and app.
// React rules (hooks + accessibility) apply to every .tsx file; NestJS rules come with the server.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/.expo/**',
      '**/storybook-static/**',
      'firmware/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // NFR-M03: `any` is not allowed without a documented reason (use an eslint-disable comment with the reason).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // React (web and native): rules of hooks, React Compiler checks and accessible JSX
    // (NFR-U05). jsx-a11y is the static half; axe-core tests in each UI package are the other.
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      // Focus on mount is a deliberate prop of our own components (e.g. the PIN pad on a kiosk
      // login screen); on raw DOM elements it stays forbidden.
      'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
    },
  },
  {
    // Tests may use non-null assertions for brevity.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // NFR-M02: the domain package is framework-free and platform-free.
    // It must run unchanged on the server, in React (web) and in React Native.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/domain must not use Node built-ins.' },
            {
              group: ['@nestjs/*', 'react', 'react-*', '@prisma/*', 'zod'],
              message: 'packages/domain is framework-free.',
            },
            {
              group: ['@rp/*'],
              message: 'packages/domain must not depend on other workspace packages.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
