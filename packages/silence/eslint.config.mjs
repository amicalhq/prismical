import { config } from '@prismical/eslint-config';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // Dependency rail: this package runs in THREE runtimes — the
      // Next.js browser bundle, the desktop renderer, and the desktop MAIN process.
      // It must therefore stay pure: no framework, no DOM, no Electron, no node.
      // `--max-warnings 0` in the lint script makes these fail the run (the shared
      // config's only-warn plugin downgrades everything to warnings).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: '@prismical/silence is framework-free — no Next imports.',
            },
            {
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message: '@prismical/silence is framework-free — no React.',
            },
            {
              group: ['electron', 'electron/*'],
              message: '@prismical/silence runs in the browser too — no Electron.',
            },
            {
              group: ['node:*', 'fs', 'path', 'effect'],
              message: '@prismical/silence must stay runtime-agnostic — no node/Effect imports.',
            },
            {
              group: ['@prismical/*'],
              message: '@prismical/silence is the bottom of the graph — it depends on nothing.',
            },
          ],
        },
      ],
    },
  },
];
