import { config } from '@prismical/eslint-config';

export default [
  ...config,
  {
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'next', 'next/*', 'electron', 'electron/*', 'node:*', 'fs', 'path', '@prismical/*'],
          message: 'app-workflow is a portable leaf package; inject platform operations.',
        }],
      }],
    },
  },
];
