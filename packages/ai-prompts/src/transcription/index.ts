/**
 * `@prismical/ai-prompts/transcription` — the pure, provider-neutral transcription helpers. Plain
 * decision logic over strings, buffers and rows — Node builtins only, no provider, no database — so
 * a local transcription lane runs the SAME chunk→segment math, silence guard, prompt builder and
 * replacement pass a hosted one does. Keep it that way: nothing in this folder may import outside
 * it at runtime.
 */

export * from './segments.js';
export * from './wav.js';
export * from './whisper-hints.js';
export * from './replace.js';
export * from './vocabulary-term.js';
