// Babel is only used by Jest to run React Native (P2-01b); the package itself builds with tsc.
// Jest runs CommonJS, so the pairing screen's lazy `import()` of the camera becomes a `require`;
// in the apps, Metro handles `import()` itself.
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['@babel/plugin-transform-dynamic-import'],
};
