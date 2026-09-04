import { config } from '@prismical/eslint-config/react';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // Shared-package dependency rails. `--max-warnings 0` in the lint script makes these
      // fail the run (the shared config's only-warn plugin downgrades
      // everything to warnings).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: 'app-ui is shared by web and desktop — no Next imports.',
            },
            {
              group: ['electron', 'electron/*'],
              message: 'app-ui must stay Electron-free.',
            },
            {
              group: ['@prismical/desktop-*'],
              message: 'Shared renderer packages must not depend on desktop packages.',
            },
          ],
        },
      ],
    },
  },
  {
    // Vendored ai-elements (the ai-sdk "ai-elements" registry components) are
    // kept verbatim so upstream refreshes stay a clean copy. Exempt them from the
    // cosmetic rules the strict `--max-warnings 0` rail would otherwise trip
    // (they carried these same warnings in the web app's tolerated baseline).
    // The dependency rails above still apply — this only relaxes lint hygiene.
    files: ['src/components/ai-elements/**/*.{ts,tsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
];
