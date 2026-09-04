// Ambient `process.env` for build-time flags. The
// ai-models settings screens gate a dev-only "Mock" provider tile on
// `process.env.NODE_ENV`. On web Next inlines it; the desktop renderer
// injects it via Vite's `define`. This declaration keeps app-ui's own
// `tsc --noEmit` from erroring, standing in for the node/Next globals that the
// web app gets from next-env.d.ts (same role as css-modules.d.ts).
declare const process: { env: Record<string, string | undefined> };
