import { config } from '@prismical/eslint-config/react';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: 'app-i18n is shared by web, login, and desktop — no Next imports.',
            },
            {
              group: ['electron', 'electron/*'],
              message: 'Electron locale detection belongs in the desktop adapter.',
            },
            {
              group: ['@prismical/app-client', '@prismical/app-ui', '@prismical/desktop-*'],
              message: 'app-i18n is a renderer-neutral dependency and cannot import its consumers.',
            },
          ],
        },
      ],
    },
  },
];
