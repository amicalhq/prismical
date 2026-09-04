import { config } from '@prismical/eslint-config/react';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // Dependency boundaries. `--max-warnings 0` in the lint script makes these
      // fail the run (the shared config's only-warn plugin downgrades
      // everything to warnings).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: 'app-client is shared by web and desktop — no Next imports.',
            },
            {
              group: ['electron', 'electron/*'],
              message: 'app-client must stay Electron-free.',
            },
            {
              group: ['@prismical/desktop-*'],
              message: 'Shared renderer packages must not depend on desktop packages.',
            },
          ],
        },
      ],
      // Environment seam: no location-based env sniffing — environment comes
      // from the injected EnvPort config (constructor-required, no fallback).
      'no-restricted-globals': [
        'error',
        {
          name: 'location',
          message: 'No location-based env sniffing in app-client — env is injected via EnvPort.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'location',
          message: 'No location-based env sniffing in app-client — env is injected via EnvPort.',
        },
        {
          object: 'globalThis',
          property: 'location',
          message: 'No location-based env sniffing in app-client — env is injected via EnvPort.',
        },
      ],
    },
  },
];
