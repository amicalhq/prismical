import { describe, expect, it } from 'vitest';
import { mintConversationId, toUiMessages, askMessageScope, askOriginScope } from './conversation';
import { uiMessageText } from './scope';

describe('mintConversationId', () => {
  it('mints a cnv_-prefixed id', () => {
    expect(mintConversationId()).toMatch(/^cnv_[a-z0-9]+$/);
  });

  it('mints a unique id each call', () => {
    expect(mintConversationId()).not.toBe(mintConversationId());
  });
});

describe('toUiMessages', () => {
  it('maps {role,content} to UIMessages with text parts and stable derived ids', () => {
    const out = toUiMessages(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      'cnv_x'
    );
    expect(out).toEqual([
      { id: 'cnv_x:0', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'cnv_x:1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('round-trips text through uiMessageText', () => {
    const [m] = toUiMessages([{ role: 'user', content: 'round trip' }], 'cnv_y');
    expect(uiMessageText(m!)).toBe('round trip');
  });

  it('preserves the question identity for regeneration after reload', () => {
    const messages = toUiMessages(
      [
        {
          role: 'user',
          content: 'Question',
          turnId: 'stable-question',
          scope: { noteIds: ['note_a'] },
        },
        { role: 'assistant', content: 'Answer' },
      ],
      'conversation'
    );
    expect(messages[0]?.id).toBe('stable-question');
    expect(askOriginScope(messages, 'conversation:1')).toEqual({ noteIds: ['note_a'] });
  });

  it('returns [] for empty history', () => {
    expect(toUiMessages([], 'cnv_z')).toEqual([]);
  });
});

describe('per-question context', () => {
  it('restores scope and follows the originating question rather than a later note', () => {
    const messages = toUiMessages(
      [
        { role: 'user', content: 'A?', scope: { noteIds: ['note_a'] } },
        { role: 'assistant', content: 'Answer A', followups: ['More A?'] },
        { role: 'user', content: 'B?', scope: { noteIds: ['note_b'] } },
        { role: 'assistant', content: 'Answer B' },
      ],
      'conversation'
    );
    expect(askOriginScope(messages, 'conversation:1')).toEqual({ noteIds: ['note_a'] });
    expect(askOriginScope(messages, 'conversation:3')).toEqual({ noteIds: ['note_b'] });
    expect(uiMessageText(messages[1]!)).toBe('Answer A\nFollow-ups: More A?');
  });
  it('distinguishes legacy history from deliberately unscoped questions without leaking context', () => {
    const messages = toUiMessages(
      [
        { role: 'user', content: 'A?', scope: { noteIds: ['note_a'] } },
        { role: 'assistant', content: 'A' },
        { role: 'user', content: 'global', scope: {} },
        { role: 'assistant', content: 'global answer' },
        { role: 'user', content: 'legacy' },
        { role: 'assistant', content: 'legacy answer' },
      ],
      'conversation'
    );
    expect(askMessageScope(messages[2])).toEqual({});
    expect(askMessageScope(messages[4])).toBeUndefined();
    expect(askOriginScope(messages, 'conversation:3')).toEqual({});
    expect(askOriginScope(messages, 'conversation:5')).toEqual({});
    expect(askOriginScope(messages, 'missing')).toEqual({});
  });
});
