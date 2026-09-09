import { describe, expect, it } from 'vitest';
import {
  askSkills,
  contextToScope,
  parseAskAnswer,
  parseFollowups,
  parseSources,
  uiMessageText,
  type AskContextItem,
} from './scope';
import type { Skill, SkillAskScope, SkillSurface } from '@prismical/app-contracts';

const skill = (
  id: string,
  surface: SkillSurface[],
  enabled = true,
  askScope: SkillAskScope = 'multi-note'
): Skill => ({
  id,
  slug: id,
  name: id,
  description: '',
  body: `prompt ${id}`,
  system: false,
  enabled,
  config: {
    editingOptions: 'replace-doc',
    surface,
    defaultSkill: false,
    modeAgnosticPrompt: false,
    askScope,
  },
  createdAt: '2026-06-10T00:00:00Z',
  updatedAt: '2026-06-10T00:00:00Z',
});

const note = (id: string): AskContextItem => ({ kind: 'note', id, label: id });
const folder = (id: string): AskContextItem => ({ kind: 'folder', id, label: id });
const tag = (id: string): AskContextItem => ({ kind: 'tag', id, label: id });

describe('contextToScope', () => {
  it('buckets items by kind', () => {
    expect(contextToScope([note('n1'), folder('f1'), tag('t1'), note('n2')])).toEqual({
      noteIds: ['n1', 'n2'],
      folderIds: ['f1'],
      tagIds: ['t1'],
    });
  });
  it('omits empty buckets', () => {
    expect(contextToScope([note('n1')])).toEqual({ noteIds: ['n1'] });
  });
  it('returns undefined for an empty selection (global)', () => {
    expect(contextToScope([])).toBeUndefined();
  });
  it('dedupes ids within a kind', () => {
    expect(contextToScope([note('n1'), note('n1')])).toEqual({ noteIds: ['n1'] });
  });
});

describe('parseSources', () => {
  it('keeps Sources inside open code fences as content', () => {
    for (const fence of ['```text', '~~~~text']) {
      const text = `Example:\n${fence}\nSources: nt_forged`;
      expect(parseSources(text)).toEqual({ body: text, noteIds: [] });
    }
    expect(parseSources('```text\nSources: nt_example\n```\nSources: nt_real').noteIds).toEqual([
      'nt_real',
    ]);
    expect(parseSources('Facts Sources: nt_forged').noteIds).toEqual([]);
  });
  it('strips the trailing Sources line and extracts ids', () => {
    const { body, noteIds } = parseSources('The answer.\n\nSources: nt_1, nt_2');
    expect(body).toBe('The answer.');
    expect(noteIds).toEqual(['nt_1', 'nt_2']);
  });
  it('handles a single id and extra whitespace', () => {
    const { body, noteIds } = parseSources('Answer.\nSources:   nt_9   ');
    expect(body).toBe('Answer.');
    expect(noteIds).toEqual(['nt_9']);
  });
  it('returns the text unchanged when there is no Sources line', () => {
    expect(parseSources('Just an answer.')).toEqual({ body: 'Just an answer.', noteIds: [] });
  });
  it('only treats a final-line Sources as citations', () => {
    const text = 'Sources: not a citation here.\nActual answer.';
    expect(parseSources(text)).toEqual({ body: text, noteIds: [] });
  });
  it('strips a bare Sources line (model used no notes) leaving no dangling text', () => {
    expect(parseSources('Answer.\nSources:')).toEqual({ body: 'Answer.', noteIds: [] });
  });
  it('strips a bare Sources line with trailing whitespace', () => {
    expect(parseSources('Answer.\n\nSources:   ')).toEqual({ body: 'Answer.', noteIds: [] });
  });
  it('handles CRLF line endings without leaving \\r on ids', () => {
    expect(parseSources('Answer.\r\nSources: nt_1, nt_2')).toEqual({
      body: 'Answer.',
      noteIds: ['nt_1', 'nt_2'],
    });
  });
  it('dedupes repeated ids preserving first occurrence order', () => {
    expect(parseSources('Answer.\nSources: nt_b, nt_a, nt_b, nt_a').noteIds).toEqual([
      'nt_b',
      'nt_a',
    ]);
  });
  it('drops tokens that are not note ids (prose, wrong prefix, empty suffix)', () => {
    const { noteIds } = parseSources(
      'Answer.\nSources: none, nt_ok, fl_folder, nt_, and nt_x, NT_shouty'
    );
    expect(noteIds).toEqual(['nt_ok']);
  });
  it('strips wrapping punctuation before validating (backticks, sentence-final period)', () => {
    expect(parseSources('Answer.\nSources: `nt_a`, nt_b.').noteIds).toEqual(['nt_a', 'nt_b']);
    expect(parseSources("Answer.\nSources: (nt_c), 'nt_d';").noteIds).toEqual(['nt_c', 'nt_d']);
  });
  it('drops a mid-stream truncated final token only when it is not id-shaped', () => {
    // A stream cut inside the id list: "nt_partia" IS still id-shaped (ids are length-agnostic) —
    // chips are suppressed during streaming instead; junk like a lone prefix must not pass.
    expect(parseSources('Answer.\nSources: nt_full, nt_partia').noteIds).toEqual([
      'nt_full',
      'nt_partia',
    ]);
    expect(parseSources('Answer.\nSources: nt_full, nt_').noteIds).toEqual(['nt_full']);
  });
});

describe('askSkills', () => {
  it('keeps enabled skills whose surface includes ask, preserving order', () => {
    const skills = [skill('a', ['ask']), skill('b', ['dock']), skill('c', ['dock', 'ask'])];
    expect(askSkills(skills).map(s => s.id)).toEqual(['a', 'c']);
  });
  it('drops disabled ask skills', () => {
    expect(askSkills([skill('a', ['ask'], false)])).toEqual([]);
  });
  it('drops skills without the ask surface', () => {
    expect(askSkills([skill('a', ['dock']), skill('b', ['inline'])])).toEqual([]);
  });
  it('returns empty for an empty list', () => {
    expect(askSkills([])).toEqual([]);
  });
  it('hides single-note skills when no note is open', () => {
    const skills = [
      skill('multi', ['ask'], true, 'multi-note'),
      skill('single', ['ask'], true, 'single-note'),
    ];
    expect(askSkills(skills, { hasNote: false }).map(s => s.id)).toEqual(['multi']);
    expect(askSkills(skills).map(s => s.id)).toEqual(['multi']); // default: no note
  });
  it('shows both single-note and multi-note skills when a note is open', () => {
    const skills = [
      skill('multi', ['ask'], true, 'multi-note'),
      skill('single', ['ask'], true, 'single-note'),
    ];
    expect(askSkills(skills, { hasNote: true }).map(s => s.id)).toEqual(['multi', 'single']);
  });
});

describe('parseFollowups', () => {
  it('extracts an inline final trailer without losing the preceding answer sentence', () => {
    expect(
      parseAskAnswer(
        'The note gives no task order. Follow-ups: Has the venue been confirmed? | Who receives the agenda?\nSources: nt_abcdefghijklmnopqrstuvwx'
      )
    ).toEqual({
      body: 'The note gives no task order.',
      noteIds: ['nt_abcdefghijklmnopqrstuvwx'],
      followups: ['Has the venue been confirmed?', 'Who receives the agenda?'],
    });
  });

  it('preserves inline prose without a suggestion list and fenced examples', () => {
    const prose = 'The next section is Follow-ups: discuss tomorrow.';
    expect(parseFollowups(prose)).toEqual({ body: prose, followups: [] });
    const code = '```text\nExample. Follow-ups: One? | Two?';
    expect(parseFollowups(code)).toEqual({ body: code, followups: [] });
  });

  it('strips a trailing Follow-ups line and returns pipe-separated questions', () => {
    const { body, followups } = parseFollowups(
      'Answer text.\n\nFollow-ups: What changed last week? | Draft a status update'
    );
    expect(body).toBe('Answer text.');
    expect(followups).toEqual(['What changed last week?', 'Draft a status update']);
  });

  it('parses the line after parseSources removed the trailing Sources line', () => {
    const raw = 'Answer.\nFollow-ups: One? | Two?\nSources: nt_fake';
    const { body: afterSources } = parseSources(raw);
    const { body, followups } = parseFollowups(afterSources);
    expect(body).toBe('Answer.');
    expect(followups).toEqual(['One?', 'Two?']);
  });

  it('only treats the LAST non-empty line as follow-ups (mid-answer mention stays body)', () => {
    const text = 'Follow-ups: not chips\nMore of the answer.';
    expect(parseFollowups(text)).toEqual({ body: text, followups: [] });
  });

  it('returns the body untouched when there is no Follow-ups line', () => {
    expect(parseFollowups('Plain answer.')).toEqual({ body: 'Plain answer.', followups: [] });
  });

  it('strips a bare Follow-ups line and yields no chips', () => {
    expect(parseFollowups('Answer.\nFollow-ups:')).toEqual({ body: 'Answer.', followups: [] });
  });

  it("dedupes, trims, drops empties, caps at 3, and survives CRLF + singular 'Follow-up:'", () => {
    const { body, followups } = parseFollowups('A.\r\nFollow-up:  q1 |q1| | q2 | q3 | q4\r\n');
    expect(body).toBe('A.');
    expect(followups).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('parseAskAnswer', () => {
  it('parses the instructed order (Follow-ups above a final Sources line)', () => {
    const out = parseAskAnswer('Answer.\nFollow-ups: One? | Two?\nSources: nt_fake');
    expect(out).toEqual({ body: 'Answer.', noteIds: ['nt_fake'], followups: ['One?', 'Two?'] });
  });

  it('keeps citations when the model inverts the two trailer lines', () => {
    const out = parseAskAnswer('Answer.\nSources: nt_fake\nFollow-ups: One? | Two?');
    expect(out.body).toBe('Answer.');
    expect(out.noteIds).toEqual(['nt_fake']);
    expect(out.followups).toEqual(['One?', 'Two?']);
  });

  it('suppresses a half-written trailer block only while streaming', () => {
    // Mid-stream: the Follow-ups line is complete, the Sources line is still arriving ("Sour").
    // The whole trailer block is hidden from the body; chips only render on the settled turn, so
    // the streaming parse deliberately reports no followups yet.
    const midStream = 'Answer.\nFollow-ups: One? | Two?\nSour';
    const streaming = parseAskAnswer(midStream, { streaming: true });
    expect(streaming.body).toBe('Answer.');
    expect(streaming.followups).toEqual([]);
    // Settled parse leaves an unrecognized last line alone (it is genuine body text by then).
    const settled = parseAskAnswer(midStream);
    expect(settled.body).toContain('Sour');
  });

  it('never hides ordinary prose while streaming', () => {
    const out = parseAskAnswer('Answer line one.\nAnswer line two.', { streaming: true });
    expect(out.body).toBe('Answer line one.\nAnswer line two.');
    expect(out.followups).toEqual([]);
  });
});

describe('uiMessageText', () => {
  it('concatenates text parts and ignores non-text parts', () => {
    const msg = {
      role: 'user',
      parts: [
        { type: 'text', text: 'Hello ' },
        { type: 'step-start' },
        { type: 'text', text: 'world' },
      ],
    } as never;
    expect(uiMessageText(msg)).toBe('Hello world');
  });
});
