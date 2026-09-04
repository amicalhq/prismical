/**
 * `@prismical/ai-prompts` — the PURE prompt/contract subset of the AI layer.
 *
 * Everything here is text the model reads and the constants that bound a run: the Ask and Skills
 * system prompts, the built-in Ask tool specs, the `submit_output` terminal-tool contract, the
 * Enhance-lane provenance rule, the Name-note prompt + title validation, and the system-skill seed
 * constants. It depends on `zod` and `@prismical/api-contracts` ONLY — no `ai`, no database
 * package, no provider SDKs — so the Electron main process can import it without dragging a
 * server package along.
 */

export * from './ask/system-prompt.js';
export * from './ask/tools.js';

export * from './skills/system-prompt.js';
export * from './skills/types.js';
export * from './skills/skill.js';
export * from './skills/note-input.js';
export * from './skills/provenance.js';
export * from './skills/title.js';

export * from './system-skills.js';
