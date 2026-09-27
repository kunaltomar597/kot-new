/** Jest with the React Native preset (Vitest cannot run React Native's Flow sources). */
module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  // The first render in a file loads React Native's renderer; on a busy CI runner (Turborepo runs
  // every package's tests at once) that alone took over Jest's 5 s default.
  testTimeout: 30_000,
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
