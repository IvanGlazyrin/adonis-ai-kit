import { configPkg } from '@adonisjs/eslint-config'

export default configPkg(
  {
    name: 'Repository ignores',
    ignores: [
      'dist/**',
      'coverage/**',
      'docs/.vitepress/**',
      'node_modules/**',
      '.superpowers/**',
      '.stryker-tmp/**',
      'tests/fixtures/**',
      '**/*.stub',
    ],
  },
  {
    name: 'Repository rules',
    rules: {
      // The source has its own layout (lines up to about 130 characters) and there is no Prettier in this repo.
      'prettier/prettier': 'off',

      // `(await call()).member` is used on purpose in tests and a few call sites; rewriting it adds a variable for nothing.
      '@unicorn/no-await-expression-member': 'off',

      // The shared config does not catch dead code, so add it. A leading underscore marks an argument or a destructured
      // value that is dropped on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // Same naming rules as the shared config, but a leading underscore is allowed for variables that are dropped
      // on purpose (`const { model: _model, ...rest } = result`).
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'class', format: ['PascalCase'] },
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
      ],
    },
  }
)
