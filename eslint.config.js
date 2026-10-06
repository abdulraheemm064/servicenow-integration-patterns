'use strict';
const js = require('@eslint/js');

const SERVICENOW_GLOBALS = {
  Class: 'readonly',
  gs: 'readonly',
  GlideRecord: 'readonly',
  GlideDateTime: 'readonly',
  GlideDigest: 'readonly',
  sn_ws: 'readonly',
  sn_auth: 'readonly',
  sn_cc: 'readonly',
  request: 'readonly',
  response: 'readonly',
  // Script Includes in this app reference each other by global name.
  CBLogger: 'writable',
  CBPayloadValidator: 'writable',
  CBRetryPolicy: 'writable',
  CBConnectionResolver: 'writable',
  CBTokenProvider: 'writable',
  CBRestClient: 'writable',
  CBIdempotencyStore: 'writable',
  CBAccountSyncService: 'writable',
  CBCoalesceHelper: 'writable',
  CBAccountEventApi: 'writable',
};

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    // Server-side scoped app code: ES5 only, as for older script engine modes.
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 5, sourceType: 'script', globals: SERVICENOW_GLOBALS },
    rules: {
      'no-redeclare': 'off',
      'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }], // ES5 requires a catch binding
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: 'error',
      'no-var': 'off',
    },
  },
  {
    files: ['test/**/*.js', 'mock-core-banking/**/*.js', 'demo/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: { eqeqeq: 'error', 'no-var': 'error', 'prefer-const': 'error' },
  },
];
