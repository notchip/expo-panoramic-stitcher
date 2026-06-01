// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('expo-module-scripts/eslint.config.base');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['build/**'],
  },
]);
