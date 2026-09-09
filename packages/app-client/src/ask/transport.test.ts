import { describe, expect, it, vi } from 'vitest';
import {
  AskSessionChangedError,
  buildAskRequest,
  exactSessionAskHeaders,
  askHeadersForPlatform,
  MAX_REQUEST_MESSAGES,
  askHelpContext,
  AskChatTransport,
  createAskTransport,
} from './transport';
import type { UIMessage } from 'ai';
import type { AuthPort, SessionView } from '@prismical/app-contracts';
import { askContinuationMessage, toUiMessages } from './conversation';
import { getClientEnv } from '../runtime';

it.each([
  { noteIds: ['nt_original'], folderIds: ['fld_original'], tagIds: ['tag_original'] },
  {},
  undefined,
])(
  'continues a restored answer with its own scope, ignoring background context: %j',
  async scope => {
    const history = toUiMessages(
      [
        { role: 'user', content: 'Original question', scope },
        { role: 'assistant', content: 'Partial answer' },
      ],
      'conversation'
    );
    const continuation = askContinuationMessage(history, 'Continue');
    const bodies: Array<{ scope?: object }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return new Response('data: {"type":"error","errorText":"interrupted"}\n\n');
    });
    const background = vi.fn(() => ({ noteIds: ['nt_background'] }));
    const transport = createAskTransport(background, 'conversation', undefined, () => ({}));
    try {
      const stream = await transport.sendMessages({
        chatId: 'conversation',
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
        messages: [
          ...history,
          {
            id: 'continuation',
            role: 'user',
            metadata: continuation.metadata,
            parts: [{ type: 'text', text: continuation.text }],
          },
        ],
      });
      await stream.cancel();
      expect(bodies[0]?.scope).toEqual(scope ?? {});
      expect(background).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  }
);

vi.mock('../runtime', () => ({
  getAskFetch: () => null,
  coreApiBaseUrl: () => 'https://core.test',
  getClientEnv: vi.fn(() => ({ platform: 'web', appVersion: null })),
}));

describe('Ask request admission', () => {
  const request = {
    chatId: 'conversation',
    messages: [
      { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    ] as UIMessage[],
    messageId: undefined,
    abortSignal: undefined,
  };

  it.each(['submit-message', 'regenerate-message'] as const)(
    'blocks %s before authentication and transport',
    async trigger => {
      const headers = vi.fn(() => ({}));
      const network = vi.spyOn(globalThis, 'fetch');
      const transport = createAskTransport(
        () => undefined,
        'conversation',
        undefined,
        headers,
        () => {
          throw new DOMException('Review pending', 'AbortError');
        }
      );
      try {
        await expect(transport.sendMessages({ ...request, trigger })).rejects.toMatchObject({
          name: 'AbortError',
        });
        expect(headers).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    }
  );

  it('rechecks admission when review starts during awaited authentication', async () => {
    let admitted = true;
    let release!: (headers: Record<string, string>) => void;
    const headers = new Promise<Record<string, string>>(resolve => {
      release = resolve;
    });
    const network = vi.spyOn(globalThis, 'fetch');
    const transport = createAskTransport(
      () => undefined,
      'conversation',
      undefined,
      () => headers,
      () => {
        if (!admitted) throw new DOMException('Review pending', 'AbortError');
      }
    );
    try {
      const pending = transport.sendMessages({ ...request, trigger: 'submit-message' });
      admitted = false;
      release({});
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('checks admission at fetch even when review starts after request preparation', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    let admitted = true;
    vi.mocked(getClientEnv).mockImplementationOnce(() => {
      queueMicrotask(() => {
        admitted = false;
      });
      return { platform: 'web', appVersion: null } as ReturnType<typeof getClientEnv>;
    });
    const transport = createAskTransport(
      () => undefined,
      'conversation',
      undefined,
      () => ({}),
      () => {
        if (!admitted) throw new DOMException('Review pending', 'AbortError');
      }
    );
    try {
      await expect(
        transport.sendMessages({ ...request, trigger: 'submit-message' })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});

it('retains the attached scope for retry, then clears it for a new unscoped question', async () => {
  const bodies: Array<{ scope?: object }> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return new Response('data: {"type":"error","errorText":"interrupted"}\n\n');
  });
  const getScope = vi
    .fn()
    .mockReturnValueOnce({ noteIds: ['nt_attached'] })
    .mockReturnValue(undefined);
  const transport = createAskTransport(getScope, 'cnv_thread', undefined, () => ({}));
  const send = async (id: string, trigger: 'submit-message' | 'regenerate-message') => {
    const stream = await transport.sendMessages({
      chatId: 'cnv_thread',
      trigger,
      messageId: undefined,
      abortSignal: undefined,
      messages: [{ id, role: 'user', parts: [{ type: 'text', text: 'question' }] }],
    });
    await stream.cancel();
  };
  try {
    await send('first', 'submit-message');
    await send('first', 'regenerate-message');
    await send('second', 'submit-message');
    expect(bodies.map(body => body.scope)).toEqual([
      { noteIds: ['nt_attached'] },
      { noteIds: ['nt_attached'] },
      undefined,
    ]);
    expect(getScope).toHaveBeenCalledTimes(2);
  } finally {
    fetch.mockRestore();
  }
});

describe('Ask stream completion', () => {
  const receive = async (events: object[]) => {
    const transport = new AskChatTransport({
      fetch: async () =>
        new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')),
    });
    const stream = await transport.sendMessages({
      chatId: 'conversation',
      messages: [],
      trigger: 'submit-message',
      messageId: undefined,
      abortSignal: undefined,
    });
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  };

  it.each([
    [],
    [{ type: 'start' }],
    [
      { type: 'start' },
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'Partial answer' },
    ],
    [{ type: 'start' }, { type: 'abort' }],
    [{ type: 'start' }, { type: 'finish', finishReason: 'stop' }],
  ])('rejects EOF without a server outcome: %j', async (...events) => {
    await expect(receive(events)).rejects.toThrow('ASK_REQUEST_FAILED');
  });

  it('preserves a completed answer', async () => {
    const events = [
      { type: 'start' },
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'An answer' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await expect(receive(events)).resolves.toEqual(events);
  });

  it('preserves the server error instead of replacing it at EOF', async () => {
    const events = [{ type: 'error', errorText: 'specific server error' }];
    await expect(receive(events)).resolves.toEqual(events);
  });

  it('preserves a pause for tool approval', async () => {
    const events = [
      { type: 'tool-approval-request', approvalId: 'approval', toolCallId: 'call' },
      { type: 'finish', finishReason: 'tool-calls' },
    ];
    await expect(receive(events)).resolves.toEqual(events);
  });
});

const userMsg = (text: string): UIMessage =>
  ({ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }) as never;

const msg = (role: 'user' | 'assistant', text: string): UIMessage =>
  ({ id: text, role, parts: [{ type: 'text', text }] }) as never;

describe('buildAskRequest', () => {
  it('sends normalized client context for platform-specific help', () => {
    expect(askHelpContext({ platform: 'darwin', appVersion: '2.0' })).toEqual({
      platform: 'macos',
      appVersion: '2.0',
    });
    expect(askHelpContext({ platform: 'win32', appVersion: null })).toEqual({
      platform: 'windows',
    });
    const helpContext = askHelpContext({ platform: 'web', appVersion: null });
    const out = buildAskRequest({
      messages: [userMsg('How do I export?')],
      scope: undefined,
      conversationId: undefined,
      headers: {},
      helpContext,
    });
    expect(out.body).toMatchObject({ helpContext: { platform: 'web' } });
  });
  it('reshapes UIMessages to {role,content} and attaches scope + auth header', () => {
    const out = buildAskRequest({
      messages: [userMsg('hi there')],
      scope: { noteIds: ['nt_1'] },
      conversationId: undefined,
      headers: { Authorization: 'Bearer abc' },
    });
    expect(out.body).toEqual({
      messages: [
        {
          role: 'user',
          content: 'hi there',
          parts: [{ type: 'text', text: 'hi there' }],
        },
      ],
      scope: { noteIds: ['nt_1'] },
      turnId: 'm1',
      suggestFollowups: true,
    });
    expect(out.headers).toEqual({ Authorization: 'Bearer abc' });
  });

  it('omits scope when undefined (global)', () => {
    const out = buildAskRequest({
      messages: [userMsg('q')],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect(out.body).toEqual({
      messages: [{ role: 'user', content: 'q', parts: [{ type: 'text', text: 'q' }] }],
      // The app clients ALWAYS opt in to follow-up chips; /v1 consumers never send it.
      turnId: 'm1',
      suggestFollowups: true,
    });
    expect('scope' in (out.body as object)).toBe(false);
  });

  it('includes conversationId when present, omits it when undefined', () => {
    const withId = buildAskRequest({
      messages: [userMsg('q')],
      scope: undefined,
      conversationId: 'cnv_abc',
      headers: {},
    });
    expect(withId.body).toEqual({
      messages: [{ role: 'user', content: 'q', parts: [{ type: 'text', text: 'q' }] }],
      conversationId: 'cnv_abc',
      turnId: 'm1',
      suggestFollowups: true,
    });
    const without = buildAskRequest({
      messages: [userMsg('q')],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect('conversationId' in (without.body as object)).toBe(false);
  });

  it('keeps a text-less (tool-only) turn as a placeholder so approval resume round-trips', () => {
    // A turn that is ONLY tool activity (no text parts) is NOT dropped — it rides
    // along as "[tool activity]" with its parts intact, so tool calls + approval
    // responses survive the reshape (dropping it would break the approval resume).
    const empty = { id: 'm0', role: 'assistant', parts: [{ type: 'step-start' }] } as never;
    const out = buildAskRequest({
      messages: [empty, userMsg('real')],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect(out.body).toEqual({
      messages: [
        {
          role: 'assistant',
          content: '[tool activity]',
          parts: [{ type: 'step-start' }],
        },
        { role: 'user', content: 'real', parts: [{ type: 'text', text: 'real' }] },
      ],
      turnId: 'm1',
      suggestFollowups: true,
    });
  });

  it('windows a long resumed thread to the most-recent MAX_REQUEST_MESSAGES, keeping the last user turn', () => {
    // A resumed conversation can seed up to 100 messages into useChat; sending them all would exceed
    // the backend's max(50). Build 60 turns ending with a fresh user question.
    const long: UIMessage[] = [];
    for (let i = 0; i < 30; i++) {
      long.push(msg('user', `q${i}`), msg('assistant', `a${i}`));
    }
    long.push(msg('user', 'newest question'));
    const out = buildAskRequest({
      messages: long,
      scope: undefined,
      conversationId: 'cnv_x',
      headers: {},
    });
    const sent = (out.body as { messages: { role: string; content: string }[] }).messages;
    expect(sent.length).toBe(MAX_REQUEST_MESSAGES);
    expect(sent.length).toBeLessThanOrEqual(50); // backend askRequestSchema cap
    expect(sent.at(-1)).toEqual({
      role: 'user',
      content: 'newest question',
      parts: [{ type: 'text', text: 'newest question' }],
    });
  });

  it('drops non user/assistant roles (e.g. system)', () => {
    const sys = { id: 's0', role: 'system', parts: [{ type: 'text', text: 'ignore me' }] } as never;
    const out = buildAskRequest({
      messages: [sys, userMsg('q')],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect(out.body).toEqual({
      messages: [{ role: 'user', content: 'q', parts: [{ type: 'text', text: 'q' }] }],
      turnId: 'm1',
      suggestFollowups: true,
    });
  });
});

describe('exactSessionAskHeaders', () => {
  const supportView: SessionView = {
    state: 'signed-in',
    accounts: [
      {
        sub: 'user_1',
        sessionKey: 'support_session_1',
        email: 'target@example.com',
        activeOrgId: 'org_1',
      },
    ],
    activeSub: 'user_1',
    activeSessionKey: 'support_session_1',
  };
  const ordinaryView: SessionView = {
    state: 'signed-in',
    accounts: [
      {
        sub: 'user_1',
        sessionKey: 'user_1',
        email: 'target@example.com',
        activeOrgId: 'org_1',
      },
    ],
    activeSub: 'user_1',
    activeSessionKey: 'user_1',
  };

  function authPort(
    getView: () => SessionView,
    getToken: AuthPort['getToken'],
    getTokenForSession: AuthPort['getTokenForSession'] = async () => getToken()
  ): AuthPort {
    return {
      getSession: getView,
      getToken,
      getTokenForSession,
      onSessionChanged: () => () => {},
      signIn: async () => {},
      addAccount: async () => {},
      signOut: async () => {},
      switchAccount: () => {},
      switchOrg: () => {},
    };
  }

  it('pins Ask and tool-approval requests to the owner session token and org', async () => {
    const auth = authPort(
      () => supportView,
      async () => 'support-token'
    );

    await expect(exactSessionAskHeaders(auth, 'support_session_1', 'org_1')).resolves.toEqual({
      Authorization: 'Bearer support-token',
      'x-active-org-id': 'org_1',
      'x-prismical-ask-error-format': 'envelope',
    });
  });

  it('rejects a pending approval resume after same-user support falls back to ordinary', async () => {
    let view = supportView;
    const auth = authPort(
      () => view,
      async () => {
        view = ordinaryView;
        return 'ordinary-token';
      }
    );

    await expect(exactSessionAskHeaders(auth, 'support_session_1', 'org_1')).rejects.toBeInstanceOf(
      AskSessionChangedError
    );
  });

  it('does not even read the ordinary token for an already-stale support chat', async () => {
    let tokenReads = 0;
    const auth = authPort(
      () => ordinaryView,
      async () => {
        tokenReads += 1;
        return 'ordinary-token';
      }
    );

    await expect(exactSessionAskHeaders(auth, 'support_session_1', 'org_1')).rejects.toBeInstanceOf(
      AskSessionChangedError
    );
    expect(tokenReads).toBe(0);
  });

  it('rejects when the bearer seam changes before the reactive session view publishes', async () => {
    let ordinaryTokenReads = 0;
    const auth = authPort(
      () => supportView,
      async () => {
        ordinaryTokenReads += 1;
        return 'ordinary-token';
      },
      async () => null
    );

    await expect(exactSessionAskHeaders(auth, 'support_session_1', 'org_1')).rejects.toBeInstanceOf(
      AskSessionChangedError
    );
    expect(ordinaryTokenReads).toBe(0);
  });

  it('rejects a delayed approval when the same exact login switches organizations', async () => {
    let view = supportView;
    const auth = authPort(
      () => view,
      async () => {
        view = {
          ...supportView,
          accounts: supportView.accounts.map(account => ({
            ...account,
            activeOrgId: 'org_2',
          })),
        };
        return 'support-token';
      }
    );

    await expect(exactSessionAskHeaders(auth, 'support_session_1', 'org_1')).rejects.toBeInstanceOf(
      AskSessionChangedError
    );
  });

  it('rejects an org seam change before the reactive session view publishes', async () => {
    const auth = authPort(
      () => supportView,
      async () => 'support-token',
      async (_sessionKey, expectedOrgId) => (expectedOrgId === 'org_2' ? 'support-token' : null)
    );

    await expect(exactSessionAskHeaders(auth, 'support_session_1', 'org_1')).rejects.toBeInstanceOf(
      AskSessionChangedError
    );
  });

  it('keeps desktop Ask token-free for main-owned IPC authentication', async () => {
    const tokenReads = vi.fn(async () => 'must-not-cross');
    const exactTokenReads = vi.fn(async () => 'must-not-cross');
    const auth = authPort(() => supportView, tokenReads, exactTokenReads);

    await expect(
      askHeadersForPlatform('desktop', auth, 'support_session_1', 'org_1')
    ).resolves.toEqual({});
    expect(tokenReads).not.toHaveBeenCalled();
    expect(exactTokenReads).not.toHaveBeenCalled();
  });
});

it('uses persisted question scope on a fresh transport for retry and approval continuation', async () => {
  const bodies: Array<{ scope?: object }> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return new Response('data: {"type":"error","errorText":"interrupted"}\n\n');
  });
  const fallback = vi.fn(() => ({ noteIds: ['wrong_background_note'] }));
  const transport = createAskTransport(fallback, 'conversation', undefined, () => ({}));
  const question: UIMessage = {
    id: 'saved-question',
    role: 'user',
    metadata: { scope: { noteIds: ['original_note'] } },
    parts: [{ type: 'text', text: 'question' }],
  };
  try {
    for (const messages of [
      [question],
      [
        question,
        {
          id: 'answer',
          role: 'assistant' as const,
          parts: [{ type: 'text' as const, text: 'paused' }],
        },
      ],
      [{ ...question, id: 'global-question', metadata: { scope: {} } }],
    ]) {
      const stream = await transport.sendMessages({
        chatId: 'conversation',
        messages,
        trigger: 'regenerate-message',
        messageId: undefined,
        abortSignal: undefined,
      });
      await stream.cancel();
    }
    expect(bodies.map(body => body.scope)).toEqual([
      { noteIds: ['original_note'] },
      { noteIds: ['original_note'] },
      {},
    ]);
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
