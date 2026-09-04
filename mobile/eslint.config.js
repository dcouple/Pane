import js from '@eslint/js';
import typescript from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  { ignores: ['www/', 'android/', 'ios/', 'node_modules/'] },
];
