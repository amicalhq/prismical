import { describe, it, expect } from 'vitest';
import { buildSkillSystemPrompt } from './system-prompt.js';
import { SUBMIT_OUTPUT_TOOL } from './types.js';
import type { RunnableSkill } from './skill.js';
import type { SkillNoteInput } from './note-input.js';

const skill = (config: RunnableSkill['config'] = {}): RunnableSkill => ({
  id: 'skl_x',
  name: 'Enhance',
  body: 'You are a helpful enhancer.',
  config,
  allowedTools: null,
});

const note = (over: Partial<SkillNoteInput> = {}): SkillNoteInput => ({
  noteId: 'nt_1',
  title: 'T',
  noteText: 'the note body',
  ...over,
});

describe('buildSkillSystemPrompt', () => {
  it('always leads with the skill body, the note, and the TERMINAL TOOL output instruction', () => {
    const p = buildSkillSystemPrompt({ skill: skill(), mode: 'append-section', input: note() });
    expect(p).toContain('You are a helpful enhancer.');
    expect(p).toContain('# Note');
    expect(p).toContain('the note body');
    expect(p).toContain('"markdown"');
    // The prompt must name the terminal-tool contract and must not contradict it.
    expect(p).toContain(SUBMIT_OUTPUT_TOOL);
    expect(p).not.toMatch(/no tool calls/i);
  });

  it('includes the mode block for a normal skill but skips it for a mode-agnostic skill', () => {
    const normal = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'append-section',
      input: note(),
    });
    expect(normal).toContain('# Active mode: append-section');

    const agnostic = buildSkillSystemPrompt({
      skill: skill({ modeAgnosticPrompt: true }),
      mode: 'append-section',
      input: note(),
    });
    expect(agnostic).not.toContain('# Active mode');
  });

  it('injects the transcript only when present, under the neutral header', () => {
    const withT = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'replace-doc',
      input: note({ transcript: 'you: hello\nthem: hi' }),
    });
    expect(withT).toContain('# Recording transcript');
    expect(withT).not.toContain('# Meeting transcript'); // the old header primed meeting output
    expect(withT).toContain('you: hello');

    const without = buildSkillSystemPrompt({ skill: skill(), mode: 'replace-doc', input: note() });
    expect(without).not.toContain('# Recording transcript');
  });

  it('carries the markdown rules for block modes but not inline-rewrite', () => {
    const block = buildSkillSystemPrompt({ skill: skill(), mode: 'append-section', input: note() });
    expect(block).toContain('# Markdown rules');
    expect(block).toContain('Never wrap the whole answer in a code fence');

    const inline = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'inline-rewrite',
      input: note(),
      selectionText: 'x',
    });
    expect(inline).not.toContain('# Markdown rules');
  });

  it('passes the note title and the recording context signals', () => {
    const p = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'replace-doc',
      input: note({
        title: 'Roadmap brainstorm',
        transcript: 'you: idea one',
        context: {
          captureMode: 'mic',
          detectedSpeakerCount: 1,
          linkedEvent: null,
        },
      }),
    });
    expect(p).toContain('# Context');
    expect(p).toContain('Note title: Roadmap brainstorm');
    expect(p).toContain('microphone only');
    expect(p).toContain('Distinct voices detected in the audio: 1');
    expect(p).toContain('No linked calendar event');

    const meeting = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'replace-doc',
      input: note({
        transcript: 'you: hi',
        context: {
          captureMode: 'dual',
          linkedEvent: { title: 'Weekly sync', attendeeCount: 4 },
        },
      }),
    });
    expect(meeting).toContain('Linked calendar event: "Weekly sync" (4 attendees)');
  });

  it('adds the refine block only when both previous output and instruction are present', () => {
    const refined = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'append-section',
      input: note(),
      refineInstruction: 'make it shorter',
      previousOutput: 'a long draft',
    });
    expect(refined).toContain('# Refine context');
    expect(refined).toContain('make it shorter');
    expect(refined).toContain('<previous-output>');
    expect(refined).toContain('a long draft');

    // First run with typed guidance (the Ask composer's `/skill …` lane): no
    // previous output, but the instruction must still steer the run.
    const firstRun = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'append-section',
      input: note(),
      refineInstruction: 'make it shorter',
    });
    expect(firstRun).not.toContain('# Refine context');
    expect(firstRun).toContain('# Extra instruction from the user');
    expect(firstRun).toContain('make it shorter');
  });

  it('marks an empty note explicitly', () => {
    const p = buildSkillSystemPrompt({
      skill: skill(),
      mode: 'append-section',
      input: note({ noteText: '   ' }),
    });
    expect(p).toContain('(empty — no content yet)');
  });

  describe('inline-rewrite', () => {
    it('injects the selection block and the single-paragraph constraint', () => {
      const p = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'inline-rewrite',
        input: note(),
        selectionText: 'teh quick brwon fox',
      });
      expect(p).toContain('# Active mode: inline-rewrite');
      expect(p).toContain('# Selected text to rewrite');
      expect(p).toContain('teh quick brwon fox');
      expect(p).toContain('SINGLE paragraph');
    });

    it('keeps the mode block even for a mode-agnostic skill (the constraint is load-bearing)', () => {
      const p = buildSkillSystemPrompt({
        skill: skill({ modeAgnosticPrompt: true }),
        mode: 'inline-rewrite',
        input: note(),
        selectionText: 'some text',
      });
      expect(p).toContain('# Active mode: inline-rewrite');
    });

    it('ignores a stray selectionText on block modes', () => {
      const p = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'append-section',
        input: note(),
        selectionText: 'should not appear',
      });
      expect(p).not.toContain('# Selected text to rewrite');
      expect(p).not.toContain('should not appear');
    });
  });

  describe('Enhance lane', () => {
    it('preserves source fragments in replacements and limits additions to the recording', () => {
      const input = note({
        noteText: 'Archive ref-a19\n\nSearch ref-b23\n\nBudget cap USD 7400; proposal only.',
        transcript: 'Speaker 1: The timeline looks tight.\nSpeaker 2: I will adjust the plan.',
      });
      const replacement = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'replace-doc',
        input,
        enhanceLane: true,
      });
      const addition = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'append-section',
        input,
        enhanceLane: true,
      });
      for (const prompt of [replacement, addition]) {
        expect(prompt).toContain(input.noteText);
        expect(prompt).toContain(input.transcript);
        expect(prompt).toContain('unless the sources explicitly connect it');
        expect(prompt).toContain('Proposed is not approved');
        expect(prompt).toContain('Action items require a request or commitment');
      }
      expect(replacement).toContain('Preserve exact identifiers');
      expect(replacement).toContain('every distinct original detail still appears');
      expect(addition).toContain('do not import its unrelated facts, owners, or commitments');
      expect(addition).not.toContain('every distinct original detail still appears');
    });

    it('keeps source fidelity when refining a draft with unsupported claims', () => {
      const prompt = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'replace-doc',
        input: note({ transcript: 'Speaker 1: A proposal.' }),
        enhanceLane: true,
        refineInstruction: 'Make it shorter',
        previousOutput: 'Approved scope.',
      });
      expect(prompt).toContain('draft to correct, not as evidence');
      expect(prompt).toContain('# Refine context');
      expect(prompt).toContain('Approved scope.');
      expect(prompt).toContain('the note body');
    });

    it('does not add the recording source contract to unrelated or unscoped skills', () => {
      const prompt = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'replace-doc',
        input: note(),
      });
      expect(prompt).not.toContain('# Source fidelity');
      expect(prompt).toContain('You are a helpful enhancer.');
    });

    it("REPLACES the skill body with the lane preamble (the stored body's self-contained-chunk contract contradicts the lane)", () => {
      const p = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'replace-doc',
        input: note({ transcript: 'you: shipped it' }),
        enhanceLane: true,
      });
      expect(p).not.toContain('You are a helpful enhancer.');
      expect(p).toContain('MEETING');
      expect(p).toContain('VOICE NOTE');
      expect(p).toContain('trust the content over the labels');
    });

    it('replace-doc: compiles the whole note + recording into one document (preserve the notes)', () => {
      const p = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'replace-doc',
        input: note({ transcript: 'you: shipped it' }),
        enhanceLane: true,
      });
      expect(p).toContain('# Active mode: replace-doc');
      expect(p).toContain('Rewrite the ENTIRE note');
      expect(p).toContain("Do NOT discard the user's notes");
    });

    it('append-section: adds a new section for THIS recording without regenerating prior content', () => {
      const p = buildSkillSystemPrompt({
        skill: skill(),
        mode: 'append-section',
        input: note({ transcript: 'you: and another thing' }),
        enhanceLane: true,
      });
      expect(p).toContain('# Active mode: append-section');
      expect(p).toContain('do NOT regenerate, restate, or');
      expect(p).toContain('new self-contained section for THIS recording');
    });

    it('forces the mode block even when the skill is mode-agnostic (Enhance output differs by mode)', () => {
      const p = buildSkillSystemPrompt({
        skill: skill({ modeAgnosticPrompt: true }),
        mode: 'replace-doc',
        input: note(),
        enhanceLane: true,
      });
      expect(p).toContain('# Active mode: replace-doc');
    });
  });
});
