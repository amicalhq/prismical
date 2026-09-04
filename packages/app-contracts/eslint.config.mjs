import { config } from '@prismical/eslint-config';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // Dependency boundary: app-contracts is the framework-free bottom of the
      // shared-renderer graph — types + port interfaces only. `--max-warnings 0`
      // in the lint script makes these fail the run (the shared config's
      // only-warn plugin downgrades everything to warnings).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: 'app-contracts is framework-free — no Next imports.',
            },
            {
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message: 'app-contracts holds types + port interfaces only — no React.',
            },
            {
              group: ['electron', 'electron/*'],
              message: 'app-contracts must stay Electron-free.',
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
];
