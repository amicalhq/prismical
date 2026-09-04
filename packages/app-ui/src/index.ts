// Canary: proves the source-consumed pipeline (exports map,
// TSX transpilation, lint, type:check) end to end. Tokens + primitives arrive
// in later modules; shell and screens follow.
export const APP_UI_CANARY = 'app-ui' as const;

export { AppUiCanary } from './canary';
