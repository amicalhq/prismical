import { outputLanguageInstruction } from './output-language.js';
import type { SkillOutputLanguage } from '@prismical/api-contracts/apps/v1';
import { SUBMIT_OUTPUT_TOOL, type ArtifactMode } from './types.js';
import type { RunnableSkill } from './skill.js';
import type { SkillNoteInput } from './note-input.js';

/** Editor-supported output syntax; editorial choices belong to the loaded skill body. */
const MARKDOWN_RULES = [
  '# Markdown rules',
  '- Output GitHub-flavored Markdown using only: paragraphs, headings (# through ######), bullet',
  '  lists (-), numbered lists, task lists (- [ ] / - [x]), **bold**, *italic*,',
  '  ~~strikethrough~~, `inline code`, fenced code blocks for actual code, > quotes, tables,',
  '  links, and --- dividers.',
  '- Do not emit images or raw HTML. Never wrap the whole answer in a code fence.',
].join('\n');

/**
 * Compose the system prompt sent to the model. The skill author's body is the star; everything else
 * is structured context.
 *
 * The model delivers its result by CALLING THE `submit_output` TOOL exactly once with
 * `{ markdown, reasoning }` — it does not answer in the chat. The prompt and
 * terminal-tool schema must describe the same output contract. Inline-rewrite
 * branches are retained but unreachable until that mode ships.
 */
export function buildSkillSystemPrompt(args: {
  /** Omitted ⇒ keep the note's own language (see `outputLanguageInstruction`). */
  outputLanguage?: SkillOutputLanguage;
  skill: RunnableSkill;
  mode: ArtifactMode;
  input: SkillNoteInput;
  /** The Enhance lane (recording→note). Its mode block is ALWAYS present and mode-aware:
   * replace-doc integrates the user's notes + the recording into one clean doc; append-section adds a
   * new section for just this recording without touching prior entries. Overrides modeAgnosticPrompt. */
  enhanceLane?: boolean;
  /** The highlighted text an inline-rewrite run targets. Only meaningful for
   * mode === 'inline-rewrite'; the handler rejects inline runs without it. */
  selectionText?: string;
  refineInstruction?: string;
  previousOutput?: string;
}): string {
  const { skill, mode, input, enhanceLane, selectionText, refineInstruction, previousOutput } =
    args;

  // Mode-agnostic skills want a self-contained chunk the user positions post-run via the diff bar
  // (append vs replace), so the mode block is skipped. The Enhance lane is the exception: its output
  // MUST differ by mode (compile-whole-note vs new-section-only), so it always gets a mode block.
  // inline-rewrite is exempted — it needs the explicit single-paragraph constraint.
  const skipModeBlock =
    !enhanceLane && skill.config.modeAgnosticPrompt === true && mode !== 'inline-rewrite';

  const out: string[] = [];
  out.push(skill.body.trim());
  out.push('');
  if (!skipModeBlock) {
    out.push(`# Active mode: ${mode}`);
    out.push(enhanceLane ? enhanceModeGuidance(mode) : modeGuidance(mode));
  }

  if (mode !== 'inline-rewrite') {
    out.push('');
    out.push(MARKDOWN_RULES);
  }

  // Cheap, factual context the model can use (title was always loaded but never passed —
  // "Roadmap brainstorm" vs "1:1 with Sam" is free disambiguation; the recording signals feed
  // the meeting vs voice-note judgement).
  out.push('');
  out.push('# Context');
  out.push(`- Note title: ${input.title || '(untitled)'}`);
  const ctx = input.context;
  if (ctx) {
    if (ctx.captureMode) {
      out.push(`- Recording capture: ${captureModeLabel(ctx.captureMode)}`);
    }
    if (typeof ctx.detectedSpeakerCount === 'number') {
      out.push(`- Distinct voices detected in the audio: ${ctx.detectedSpeakerCount}`);
    }
    out.push(
      ctx.linkedEvent
        ? `- Linked calendar event: "${ctx.linkedEvent.title}"${
            typeof ctx.linkedEvent.attendeeCount === 'number'
              ? ` (${ctx.linkedEvent.attendeeCount} attendees)`
              : ''
          }`
        : '- No linked calendar event'
    );
  }

  if (input.noteText.trim().length > 0) {
    out.push('');
    out.push('# Note');
    out.push(input.noteText);
  } else {
    out.push('');
    out.push('# Note');
    out.push('(empty — no content yet)');
  }

  // The selection block sits right after the note so the model sees the target in its context.
  // Only for inline-rewrite — other modes ignore a stray selectionText rather than confusing the
  // prompt with an unexplained block.
  if (mode === 'inline-rewrite' && selectionText) {
    out.push('');
    out.push('# Selected text to rewrite');
    out.push(selectionText);
  }

  if (input.transcript) {
    out.push('');
    // Neutral label: this is just as often a solo voice memo as a meeting — "# Meeting
    // transcript" primed meeting-minutes output for every dictation.
    out.push('# Recording transcript');
    out.push(input.transcript);
  }

  if (refineInstruction && previousOutput) {
    out.push('');
    out.push('# Refine context');
    // Tag-delimited, not a ``` fence: the previous output routinely CONTAINS fences, which
    // would close the wrapper early and garble the block.
    out.push('Your previous output is between the <previous-output> tags:');
    out.push('<previous-output>');
    out.push(previousOutput);
    out.push('</previous-output>');
    out.push(`The user wants you to revise it: ${refineInstruction}`);
  } else if (refineInstruction) {
    // First run with typed guidance (the Ask composer's `/skill …` lane, dock
    // v3): no previous output to revise — the instruction steers this run.
    out.push('');
    out.push('# Extra instruction from the user');
    out.push(refineInstruction);
  }

  out.push('');
  out.push(outputLanguageInstruction(args.outputLanguage));
  out.push('');
  out.push('# Output');
  out.push(
    `Call the \`${SUBMIT_OUTPUT_TOOL}\` tool exactly once, as your FINAL action, with ` +
      '{ "markdown": "<your output>", "reasoning": <string|null> }. Do not write the answer in the ' +
      'chat and do not call it more than once. ' +
      (skipModeBlock
        ? 'The markdown will be inserted into the note as-is.'
        : 'The markdown will be inserted into the note based on the active mode — append-section ' +
          'appends a new block, replace-doc replaces the whole note, inline-rewrite replaces just ' +
          'the selected text.')
  );

  return out.join('\n');
}

/** mic/system/dual → a phrase the model can reason about. */
function captureModeLabel(mode: string): string {
  switch (mode) {
    case 'mic':
      return 'microphone only (a single mic can be recording a whole room)';
    case 'system':
      return 'system audio only (the other side of a call)';
    case 'dual':
      return 'microphone + system audio (a call: "you" is the local speaker, "them" the remote side)';
    default:
      return mode;
  }
}

function modeGuidance(mode: ArtifactMode): string {
  switch (mode) {
    case 'append-section':
      return 'Return only the new content to append. Do not include or rewrite the existing note.';
    case 'replace-doc':
      return "Produce a complete replacement for the note's body.";
    case 'inline-rewrite':
      // The client hard-rejects anything but a single paragraph (markdownToInlineChildren), so the
      // constraint must be explicit here — a heading/list/multi-paragraph emission fails the run.
      return [
        'Rewrite ONLY the text under "# Selected text to rewrite" — the rest of the note is context,',
        'not part of your output. Return the rewritten text as a SINGLE paragraph of plain inline',
        'markdown (bold/italic/links are fine). Do NOT return headings, lists, code blocks, block',
        'quotes, multiple paragraphs, or any surrounding text from the note.',
      ].join(' ');
  }
}

/**
 * Mode guidance for the Enhance lane (recording→note). The whole note body ("# Note") AND the scoped
 * recording transcript ("# Recording transcript") are always in context; these two branches decide
 * whether the model rebuilds the whole note or only adds a new section — the rule that
 * protects a running note / journal from being regenerated on every recording.
 */
function enhanceModeGuidance(mode: ArtifactMode): string {
  switch (mode) {
    case 'replace-doc':
      return [
        'Return the complete replacement note body, integrating the written note and this recording.',
        "Preserve the user's written information, including exact identifiers and uncertainty.",
        'Use the skill instructions to decide how to transform the recording. Do not invent facts.',
      ].join(' ');
    case 'append-section':
      return [
        'Return only the new content from THIS recording to append. The existing note stays unchanged.',
        'Use the existing note only to avoid duplication and resolve explicit references; do not',
        'import unrelated facts, owners, or commitments from it. Do not invent facts.',
      ].join(' ');
    case 'inline-rewrite':
      return modeGuidance(mode);
  }
}
