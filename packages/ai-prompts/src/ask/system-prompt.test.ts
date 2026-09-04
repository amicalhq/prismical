import { describe, it, expect } from 'vitest';
import {
  buildAskSystemPrompt,
  stripFollowupsLine,
  MAX_FOCUS_CHARS_TOTAL,
} from './system-prompt.js';

describe('buildAskSystemPrompt', () => {
  it('always instructs grounding, the Sources line, and tool usage', () => {
    const p = buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: false });
    expect(p).toContain('search_notes');
    expect(p).toContain('get_note');
    expect(p).toContain('empty query');
    expect(p).toContain('Sources:');
  });

  it('instructs conciseness, summarize-over-enumerate, and the Sources cap', () => {
    const p = buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: false });
    expect(p).toContain('Keep answers concise');
    expect(p).toContain('summarize instead');
    expect(p).toContain('capped at the 8 most relevant');
  });

  it('injects focus note title + id + body when focus notes are present', () => {
    const p = buildAskSystemPrompt({
      focusNotes: [{ noteId: 'note_1', title: 'Q3 Plan', contentText: 'hire two engineers' }],
      hasScopeFilter: false,
    });
    expect(p).toContain('Q3 Plan');
    expect(p).toContain('note_1');
    expect(p).toContain('hire two engineers');
  });

  it('mentions the scope restriction only when filtering', () => {
    expect(buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: true })).toContain('scoped');
    expect(buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: false })).not.toContain('scoped');
  });

  it('instructs the Follow-ups line only when the client opted in', () => {
    const on = buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: false, suggestFollowups: true });
    expect(on).toContain('Follow-ups:');
    // Above Sources — clients parse citations off the LAST line, so Sources must stay last.
    expect(on).toContain('Directly before the `Sources:` line');
    const off = buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: false });
    expect(off).not.toContain('Follow-ups:');
  });

  it('strips the ephemeral Follow-ups trailer before persistence, keeping Sources last', () => {
    expect(stripFollowupsLine('Answer.\nFollow-ups: One? | Two?\nSources: nt_a')).toBe(
      'Answer.\nSources: nt_a'
    );
    expect(stripFollowupsLine('Answer.\nFollow-ups: One? | Two?')).toBe('Answer.');
    // No trailer — untouched (a mid-answer mention is body text, not a trailer).
    const plain = 'Follow-ups: not a trailer\nMore answer.\nSources: nt_a';
    expect(stripFollowupsLine(plain)).toBe(plain);
    expect(stripFollowupsLine('Just an answer.')).toBe('Just an answer.');
  });

  it('caps total injected focus content at the budget', () => {
    const big = 'x'.repeat(MAX_FOCUS_CHARS_TOTAL * 2);
    const p = buildAskSystemPrompt({
      focusNotes: [{ noteId: 'n', title: 'T', contentText: big }],
      hasScopeFilter: false,
    });
    expect(p).toContain('[...truncated]');
    expect(p.length).toBeLessThan(MAX_FOCUS_CHARS_TOTAL + 2000);
  });
});

describe('buildAskSystemPrompt without tools', () => {
  it('stops advertising the tools and the Sources line when the run is tool-less', () => {
    const prompt = buildAskSystemPrompt({
      focusNotes: [{ noteId: 'nt_1', title: 'T', contentText: 'body' }],
      hasScopeFilter: true,
      toolsAvailable: false,
    });
    expect(prompt).toContain('NO tools in this session');
    expect(prompt).not.toContain('search_notes');
    expect(prompt).not.toContain('get_note');
    expect(prompt).not.toContain('Sources:');
    expect(prompt).not.toContain('scoped this question');
    expect(prompt).toContain('### T (noteId: nt_1)');
  });
  it('defaults to the tool-bearing prompt', () => {
    const prompt = buildAskSystemPrompt({ focusNotes: [], hasScopeFilter: false });
    expect(prompt).toContain('`search_notes`');
    expect(prompt).toContain('Sources:');
  });
});
