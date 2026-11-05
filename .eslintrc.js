module.exports = {
  env: {
    node: true,
    es2021: true
  },
  extends: ['eslint:recommended', 'plugin:prettier/recommended'],
  parserOptions: {
    ecmaVersion: 'latest'
  },
  overrides: [
    {
      // The local dashboard page script runs in the browser, not Node.
      files: ['lib/dashboard/**/*.js'],
      env: { browser: true, node: false },
      parserOptions: { sourceType: 'script' }
    }
  ],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }]
  }
};
