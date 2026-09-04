import { config } from '@prismical/eslint-config';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    rules: {
      // This package defines the IPC membrane and must never
      // pull Electron (or anything renderer/main-specific) into its graph.
      'no-restricted-imports': [
        'warn',
        { paths: [{ name: 'electron', message: 'desktop-contracts must stay Electron-free.' }] },
      ],
    },
  },
];
