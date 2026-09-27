/** Jest with the React Native preset (Vitest cannot run React Native's Flow sources). */
module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  // The first render in each test file transforms and loads React Native's renderer. On a CI runner
  // with every package's tests running at once and a cold transform cache, that alone has taken
  // over 30 s, so tests get 2 minutes; CI keeps the transform cache between runs (ci.yml).
  testTimeout: 120_000,
  cacheDirectory: '<rootDir>/../../node_modules/.cache/jest',
  // Sources import with NodeNext `.js` extensions; Jest resolves them to the `.ts(x)` files.
  // The preset's resolver ignores `exports`, so the workspace packages point at their builds.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@rp/(design-tokens|domain)$': '<rootDir>/../$1/dist/index.js',
  },
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm|(@react-native|react-native|@rp)/))'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/index.ts'],
  coverageThreshold: { global: { lines: 90, functions: 90, statements: 90, branches: 80 } },
};
