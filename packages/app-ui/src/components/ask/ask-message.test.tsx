// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { toUiMessages } from '../../../../app-client/src/ask/conversation';
import type { UIMessage } from 'ai';

const NOTE_ID = 'nt_abcdefghijklmnopqrstuvwx';
vi.mock('@prismical/app-client', async () => ({
  ...(await import('../../../../app-client/src/ask/scope')),
  ...(await import('../../../../app-client/src/ask/conversation')),
  useNotes: () => ({ data: [{ id: 'nt_abcdefghijklmnopqrstuvwx', title: 'Cedar plan' }] }),
}));
vi.mock('../../shell/app-link', () => ({
  AppLink: (props: React.ComponentProps<'a'>) => <a {...props} />,
}));
vi.mock('../ai-elements/message', () => ({
  MessageResponse: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const { AskMessage } = await import('./ask-message');
const i18n = createApplicationI18nSync('en');
afterEach(cleanup);

function show(message: UIMessage, streaming = false) {
  return (
    <I18nextProvider i18n={i18n}>
      <AskMessage message={message} streaming={streaming} isLast onFollowup={() => {}} />
    </I18nextProvider>
  );
}

function expectSourceLink() {
  fireEvent.click(screen.getByRole('button', { name: /1 source/i }));
  expect(screen.getByRole('link', { name: /Cedar plan/ }).getAttribute('href')).toBe(
    `/notes/${NOTE_ID}`
  );
  expect(screen.queryByText(/Sources:/)).toBeNull();
}

describe('AskMessage sources', () => {
  it('shows verified sources after streaming finishes, including a separate trailer text part', () => {
    const message: UIMessage = {
      id: 'answer',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'The deadline is Friday.\n' },
        { type: 'text', text: `Sources: ${NOTE_ID}` },
      ],
    };
    const { rerender } = render(show(message, true));
    expect(screen.queryByRole('button', { name: /1 source/i })).toBeNull();
    rerender(show(message));
    expectSourceLink();
  });

  it('restores source links alongside stored follow-up suggestions', () => {
    const [message] = toUiMessages(
      [
        {
          role: 'assistant',
          content: `The deadline is Friday.\nSources: ${NOTE_ID}`,
          followups: ['Who owns the next step?'],
        },
      ],
      'conversation'
    );
    render(show(message!));
    expectSourceLink();
    expect(screen.getByRole('button', { name: 'Who owns the next step?' })).toBeTruthy();
  });

  it('renders suggestions from a restored inline trailer without leaking it into the answer', () => {
    const [message] = toUiMessages(
      [
        {
          role: 'assistant',
          content: `The deadline is Friday. Follow-ups: Who owns it? | What remains?\nSources: ${NOTE_ID}`,
        },
      ],
      'conversation'
    );
    render(show(message!));
    expect(screen.getByText('The deadline is Friday.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Who owns it?' })).toBeTruthy();
    expect(screen.queryByText(/Follow-ups:/)).toBeNull();
    expectSourceLink();
  });

  it('does not turn malformed source IDs or attachments into answer citations', () => {
    render(
      show({
        id: 'answer',
        role: 'assistant',
        metadata: { scope: { noteIds: [NOTE_ID] } },
        parts: [{ type: 'text', text: 'Answer.\nSources: note_seed_standup, https://example.com' }],
      })
    );
    expect(screen.queryByRole('button', { name: /source/i })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
