import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';

/** The MessagePort carries SSE bytes, including failures before a model stream opens. */
export const askErrorResponse = (errorText: string): Response =>
  createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'error', errorText });
      },
    }),
  });
