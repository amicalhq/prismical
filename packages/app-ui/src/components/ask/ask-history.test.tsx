// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AskHistoryList } from './ask-history';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  refetch: vi.fn(),
  more: vi.fn(),
  query: vi.fn(),
  pending: false,
  error: false,
  empty: false,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@prismical/app-i18n', async importOriginal => ({
  ...(await importOriginal<typeof import('@prismical/app-i18n')>()),
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
}));
vi.mock('@prismical/app-client', () => ({
  loadAskConversation: mocks.load,
  useConversationHistory: (query: string) => {
    mocks.query(query);
    return {
      data: {
        pages: [
          {
            conversations: mocks.empty
              ? []
              : [
                  {
                    id: 'current',
                    title: 'Current question',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                  },
                  { id: 'older', title: 'Older question', updatedAt: '2026-09-30T00:00:00.000Z' },
                ],
          },
        ],
      },
      isPending: mocks.pending,
      isError: mocks.error,
      isFetching: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: mocks.more,
      refetch: mocks.refetch,
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.error = false;
  mocks.empty = false;
});
afterEach(cleanup);
const props = { currentId: 'current', disabled: false, onSelect: vi.fn() };
it('marks the current chat and loads an older conversation before switching', async () => {
  const conversation = { id: 'older', messages: [{ role: 'user', content: 'Saved question' }] };
  mocks.load.mockResolvedValue(conversation);
  render(<AskHistoryList {...props} />);
  expect(
    screen.getByRole('button', { name: /Current question/ }).getAttribute('aria-current')
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /Older question/ }));
  await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(conversation));
  expect(mocks.load).toHaveBeenCalledWith('older');
});
it('searches after a short debounce and requests more pages', async () => {
  render(<AskHistoryList {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: ' pricing ' } });
  await waitFor(() => expect(mocks.query).toHaveBeenLastCalledWith('pricing'));
  fireEvent.click(screen.getByRole('button', { name: 'ask.history.more' }));
  expect(mocks.more).toHaveBeenCalledOnce();
});
it('does not replace the chat after closing the picker or changing owner', async () => {
  let resolve!: (value: unknown) => void;
  mocks.load.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  const view = render(<AskHistoryList {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Older question/ }));
  view.unmount();
  resolve({ id: 'older', messages: [] });
  await Promise.resolve();
  expect(props.onSelect).not.toHaveBeenCalled();
});
it('keeps the current chat when loading fails and permits retry', async () => {
  mocks.load.mockRejectedValue(new Error('offline'));
  render(<AskHistoryList {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Older question/ }));
  await screen.findByRole('alert');
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Older question/ }).hasAttribute('disabled')).toBe(
    false
  );
});
it('shows an empty state and retry for a failed list request', () => {
  mocks.empty = true;
  const view = render(<AskHistoryList {...props} />);
  expect(screen.getByText('ask.history.empty')).toBeTruthy();
  mocks.error = true;
  view.rerender(<AskHistoryList {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.retry' }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});
