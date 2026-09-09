import { describe, expect, it } from 'vitest';
import { AskAppRequestSchema, AskRequestSchema, AskConversationResponseSchema } from './ask.js';

describe('Ask conversation context contract', () => {
  it('preserves context, stable turn identity, and follow-ups on load', () => {
    const conversation = {
      id: 'conversation',
      messages: [
        { role: 'user', content: 'Question', scope: { noteIds: ['note_a'] }, turnId: 'question' },
        { role: 'assistant', content: 'Answer', followups: ['More?'] },
        { role: 'user', content: 'Global', scope: {} },
        { role: 'assistant', content: 'Legacy answer' },
      ],
    };
    expect(AskConversationResponseSchema.parse(conversation)).toEqual(conversation);
  });
  it('adds turn identity only to the app request contract', () => {
    const request = { messages: [{ role: 'user', content: 'Question' }], turnId: 'question' };
    expect(AskAppRequestSchema.parse(request).turnId).toBe('question');
    expect(AskRequestSchema.parse(request)).not.toHaveProperty('turnId');
    expect(AskAppRequestSchema.safeParse({ ...request, turnId: 'x'.repeat(129) }).success).toBe(
      false
    );
  });
});
