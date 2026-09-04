/**
 * Honour the `_name` opt-out the codebase already writes for deliberately-unused bindings — mock
 * signatures kept for their types, destructured-and-dropped keys, ignored catch params.
 *
 * tseslint's recommended preset ships `@typescript-eslint/no-unused-vars` with no ignore pattern,
 * so every one of those warned, and packages that lint with `--max-warnings 0` failed on them.
 *
 * This has to be spread LAST in each exported config: several presets here re-spread
 * `tseslint.configs.recommended` after the base config, which would otherwise reset the rule to
 * its default options.
 *
 * @type {import("eslint").Linter.Config}
 */
export const unusedVars = {
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      },
    ],
  },
};
