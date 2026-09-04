import { config } from '@prismical/eslint-config';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    ignores: [
      '.vite/**',
      'out/**',
      'e2e/.artifacts/**',
      // Parked import (kept verbatim; see the README inside).
      'src/renderer/widget-import/**',
      'scripts/**/*.cjs',
    ],
  },
];
