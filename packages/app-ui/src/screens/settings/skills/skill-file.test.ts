import { describe, expect, it } from 'vitest';
import { skillFromMarkdown, skillToMarkdown, DEFAULT_SKILL_CONFIG } from './skill-file';

describe('skill files', () => {
  it('round-trips a naming skill without changing its target, transcript input, or prompt', () => {
    const skill = {
      name: 'Name: "note"',
      description: 'First line\nSecond line',
      body: '# Instructions\nKeep it short.\n',
      config: {
        ...DEFAULT_SKILL_CONFIG,
        outputTarget: 'note-title' as const,
        inputs: { transcript: true },
      },
    };
    expect(skillFromMarkdown(skillToMarkdown(skill), 'fallback')).toEqual(skill);
  });
  it('imports a plain Markdown prompt as an ordinary body skill', () => {
    expect(skillFromMarkdown('Summarize this note.', 'Summary')).toEqual({
      name: 'Summary',
      description: '',
      body: 'Summarize this note.',
      config: DEFAULT_SKILL_CONFIG,
    });
  });
});
