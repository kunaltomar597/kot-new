/** Jest with the React Native preset, as in `@rp/ui-native`; the Keystore module is mocked. */
module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  testTimeout: 30_000,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@rp/([a-z0-9-]+)$': '<rootDir>/../../packages/$1/dist/index.js',
    '^@rp/([a-z0-9-]+)/testing$': '<rootDir>/../../packages/$1/dist/testing/index.js',
  },
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm|(@react-native|react-native|@rp)/))'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/Root.tsx'],
  coverageThreshold: { global: { lines: 80, functions: 80, statements: 80, branches: 70 } },
};
