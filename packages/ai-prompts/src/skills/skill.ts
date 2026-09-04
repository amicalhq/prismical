/**
 * The portable skill configuration used by a skill run after access checks.
 */

import type { ArtifactMode } from './types.js';

/** The skill configuration used at run time. Other keys are not needed here. */
export interface SkillRunConfig {
  outputTarget?: 'note-body' | 'note-title';
  editingOptions?: ArtifactMode;
  modeAgnosticPrompt?: boolean;
  inputs?: { transcript?: boolean };
}

export interface RunnableSkill {
  id: string;
  name: string;
  body: string;
  config: SkillRunConfig;
  /** MCP tool grants: `mcp:{serverId}:{tool}` / `mcp:{serverId}:*`; null = none. */
  allowedTools: unknown;
}
