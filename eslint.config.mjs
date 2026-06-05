import js from '@eslint/js';

const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  EventSource: 'readonly',
  Worker: 'readonly',
  ResizeObserver: 'readonly',
  requestAnimationFrame: 'readonly',
  URLSearchParams: 'readonly'
};

const nodeGlobals = {
  __dirname: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  module: 'readonly',
  process: 'readonly',
  require: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  fetch: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'scanner']
  },
  js.configs.recommended,
  {
    files: ['public/js/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['public/treemap-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        d3: 'readonly',
        importScripts: 'readonly',
        self: 'readonly'
      }
    }
  },
  {
    files: ['*.js', 'server/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly'
      }
    }
  }
];
