/**
 * Two of the project's hard rules are enforced here rather than by review,
 * because both failure modes are invisible in a diff and expensive to
 * retrofit (Master Plan R-05, R-03; brief §7).
 *
 *   1. Time. All domain and job time goes through the injected TimeProvider
 *      so the demo time machine works without touching domain logic (PA-05).
 *      A single `new Date()` in a maturity job silently breaks it.
 *
 *   2. Money. Money is numeric(18,3) in the DB, Decimal in code, and a 3-dp
 *      string on the wire. Float arithmetic on money is a defect, always.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.cjs', 'dist/**', 'node_modules/**'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    // --- Money (hard rule 2) --------------------------------------------
    // Applies everywhere in the API. parseFloat/Number on a money string
    // loses precision at the third decimal; use the Money helper.
    'no-restricted-globals': [
      'error',
      {
        name: 'parseFloat',
        message:
          'parseFloat loses precision on money. Use Money.from() (src/common/money) — decimal.js all the way to the wire.',
      },
    ],
    'no-restricted-properties': [
      'error',
      {
        object: 'Number',
        property: 'parseFloat',
        message: 'Number.parseFloat loses precision on money. Use Money.from() (src/common/money).',
      },
      {
        object: 'Math',
        property: 'round',
        message:
          'Math.round is float rounding. Money rounds half-up at 3 dp via Money.round() (src/common/money); the rule is defined once in docs/specs/ARCHITECTURE.md.',
      },
    ],
  },

  overrides: [
    {
      // --- Time (hard rule 4) -------------------------------------------
      // Domain logic and jobs only. Infrastructure (logging timestamps,
      // HTTP cache headers, the TimeProvider itself) legitimately reads the
      // wall clock and lives outside these paths.
      files: ['src/modules/**/*.ts', 'src/jobs/**/*.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "NewExpression[callee.name='Date']",
            message:
              'Direct `new Date()` is banned in domain logic and jobs. Inject TimeProvider and call time.now() — the demo time machine (ZM-DEMO-003/004) applies its offset there and nowhere else.',
          },
          {
            selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
            message:
              'Direct `Date.now()` is banned in domain logic and jobs. Inject TimeProvider and call time.now().',
          },
          {
            selector: "MemberExpression[object.name='Date'][property.name='now']",
            message: 'Direct `Date.now` is banned in domain logic and jobs. Inject TimeProvider.',
          },
        ],
      },
    },
    {
      // The TimeProvider is the one place allowed to read the wall clock.
      files: ['src/common/time/**/*.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Tests construct fixed dates deliberately, and assert on frozen clocks.
      files: ['test/**/*.ts', 'src/**/*.spec.ts'],
      rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
