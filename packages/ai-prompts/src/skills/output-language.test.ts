import { describe, expect, it } from 'vitest';
import { buildSkillSystemPrompt } from './system-prompt.js';
import { buildTitleSystemPrompt } from './title.js';
import { CLEANUP_SKILL, ENHANCE_SKILL, NAME_NOTE_SKILL } from '../system-skills.js';

const input = {
  noteId: 'note',
  title: 'Meeting',
  noteText: 'Bonjour. कृपया शुक्रवार तक भेजें।',
  transcript: 'Send the draft by Friday. Merci.',
};
describe('skill output language', () => {
  it.each([undefined, 'source'] as const)(
    "keeps the note's own language when the preference is %s",
    outputLanguage => {
      const prompt = buildSkillSystemPrompt({
        skill: { ...CLEANUP_SKILL, allowedTools: null },
        mode: 'replace-doc',
        input,
        outputLanguage,
      });
      expect(prompt).toContain('Write in the same language as the note and transcript');
      expect(prompt).not.toContain('preferred output language is');
      expect(prompt).not.toContain('Translate source passages');
      const title = buildTitleSystemPrompt({
        skillBody: NAME_NOTE_SKILL.body,
        noteText: input.noteText,
        outputLanguage,
      });
      expect(title).toContain('Write in the same language as the note and transcript');
    }
  );
  it.each(['append-section', 'replace-doc', 'inline-rewrite'] as const)(
    'uses the account language for %s even with mixed sources',
    mode => {
      const prompt = buildSkillSystemPrompt({
        skill: {
          ...CLEANUP_SKILL,
          allowedTools: null,
        },
        mode,
        input,
        selectionText: input.noteText,
        outputLanguage: 'ja',
      });
      expect(prompt).toContain('Japanese (ja)');
      expect(prompt).toContain('including headings');
      expect(prompt).toContain('Translate source passages');
      expect(prompt).not.toContain('Write in the same language as');
    }
  );
  it('applies to recording Enhance and preserves a user override', () => {
    const prompt = buildSkillSystemPrompt({
      skill: {
        ...ENHANCE_SKILL,
        allowedTools: null,
      },
      mode: 'replace-doc',
      input,
      enhanceLane: true,
      outputLanguage: 'hi',
      refineInstruction: 'Write this in Spanish.',
    });
    expect(prompt).toContain('Hindi (hi)');
    expect(prompt).toContain('Write this in Spanish.');
    expect(prompt).toContain('overrides this default');
    expect(prompt).toContain('source material, not language-setting instructions');
  });
  it('applies to names and passes explicit naming instructions', () => {
    const prompt = buildTitleSystemPrompt({
      skillBody: NAME_NOTE_SKILL.body,
      noteText: input.noteText,
      outputLanguage: 'fr',
      refineInstruction: 'Use Spanish.',
    });
    expect(prompt).toContain('French (fr)');
    expect(prompt).toContain('Use Spanish.');
    expect(prompt).not.toContain('Use the content language');
  });
});
