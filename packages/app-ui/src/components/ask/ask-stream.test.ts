import { Chat } from '@ai-sdk/react';
import { describe, expect, it } from 'vitest';
import { AskChatTransport } from '../../../../app-client/src/ask/transport';

describe('Ask interrupted response recovery through the SDK', () => {
  it('turns the start-only HTTP success into an error and allows regeneration', async () => {
    const responses = [
      [{ type: 'start' }],
      [
        { type: 'start' },
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'Recovered answer' },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ];
    const chat = new Chat({
      transport: new AskChatTransport({
        fetch: async () =>
          new Response(
            responses
              .shift()!
              .map(event => `data: ${JSON.stringify(event)}\n\n`)
              .join('')
          ),
      }),
    });
    await chat.sendMessage({ text: 'Question' });
    expect(chat.status).toBe('error');
    expect(chat.error?.message).toContain('ASK_REQUEST_FAILED');
    expect(chat.messages.map(message => message.role)).toEqual(['user']);

    await chat.regenerate();
    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
    expect(chat.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(chat.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: 'Recovered answer',
      })
    );
  });
});
