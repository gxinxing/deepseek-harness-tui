// Flat config — ESLint 9+
export default [
  {
    ignores: ['node_modules/', 'coverage/', '.husky/', '.git/', '.eslintrc.json'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^(_|el$|key$)' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-prototype-builtins': 'off',
    },
  },
  // Test files: relax unused-var for expect-style patterns
  {
    files: ['test/**/*.js'],
    rules: {
      'no-unused-expressions': 'off',
    },
  },
];
