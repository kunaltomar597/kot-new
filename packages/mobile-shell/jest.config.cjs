/** Jest with the React Native preset, as in `@rp/ui-native` (Vitest cannot run React Native). */
module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  // The first render in a file loads React Native's renderer, slow on a busy CI runner.
  testTimeout: 30_000,
  // Sources import with NodeNext `.js` extensions; Jest resolves them to the `.ts(x)` files.
  // The preset's resolver ignores `exports`, so the workspace packages point at their builds.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@rp/([a-z0-9-]+)$': '<rootDir>/../$1/dist/index.js',
    '^@rp/([a-z0-9-]+)/testing$': '<rootDir>/../$1/dist/testing/index.js',
  },
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm|(@react-native|react-native|@rp)/))'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/index.ts'],
  coverageThreshold: { global: { lines: 85, functions: 85, statements: 85, branches: 75 } },
};
