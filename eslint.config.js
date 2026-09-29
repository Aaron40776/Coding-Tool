import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The core must stay UI-independent so a web/desktop UI can reuse it.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['ink', 'ink-*', 'react', 'react/*', '**/ui/*', '**/ui'], message: 'src/core must not import UI code.' }] },
      ],
    },
  },
);
