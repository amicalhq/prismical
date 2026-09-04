/**
 * Package root (`@prismical/eslint-config`) — the entrypoint most packages here extend.
 *
 * This used to be a byte-for-byte copy of base.js, so every rule change had to be made twice or
 * the two entrypoints silently drifted. It re-exports instead: `.` and `./base` are now the same
 * config, and `./react` (which extends this) and `./next` + `./react-internal` (which extend
 * base.js) genuinely share one definition.
 *
 * @type {import("eslint").Linter.Config}
 */
export { config } from "./base.js";
