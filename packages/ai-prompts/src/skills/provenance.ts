/**
 * The pure Enhance-lane provenance rule shared by cloud and local skill
 * runners, so both resolve the mode from one implementation.
 */

import type { ArtifactMode } from './types.js';

/**
 * Pure mode-bias rule for the Enhance lane. The FIRST enhance compiles the scratch note + recording
 * into one clean document (`replace-doc`); every later enhance appends a new section so prior
 * entries are never regenerated (`append-section`) — that is how a running note / journal is
 * protected.
 */
export function enhanceDefaultMode(hasPriorEnhanceArtifact: boolean): ArtifactMode {
  return hasPriorEnhanceArtifact ? 'append-section' : 'replace-doc';
}
