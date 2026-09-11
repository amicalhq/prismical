// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecordingSessionClient, RecordingSessionSnapshot } from './recording-session';
import { useWorkflowRecording } from './use-workflow-recording';

const spies = vi.hoisted(() => ({ capture: vi.fn(), enhance: vi.fn() }));
vi.mock('../ports-context', () => ({
  usePorts: () => ({ analytics: { capture: spies.capture } }),
}));
vi.mock('../notes/auto-enhance-store', () => ({
  useAutoEnhanceStore: { getState: () => ({ requestAutoEnhance: spies.enhance }) },
}));
vi.mock('../api/hooks/transcripts', () => ({
  transcriptKey: (id: string) => ['transcript', id],
  recordingsKey: (id: string) => ['recordings', id],
  noteRecordingsKey: (id: string) => ['note-recordings', id],
  enhancedRecordingsKey: (id: string) => ['enhanced-recordings', id],
}));
vi.mock('../api/hooks/usage', () => ({ usageKeyPrefix: ['usage'] }));

type Completion = NonNullable<RecordingSessionSnapshot['completedRecording']>;
const completion = (recordingId: string, workflowId?: string): Completion => ({
  recordingId,
  workflowId,
  noteId: 'note',
  ownerSessionKey: 'owner',
  ownerOrgId: 'org',
  segments: 2,
});
function makeClient(finished: Completion | null) {
  let snapshot = { completedRecording: finished } as RecordingSessionSnapshot;
  const listeners = new Set<() => void>();
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    abandon: vi.fn(),
    clearError: vi.fn(),
    keepRecording: vi.fn(),
    pauseFromPrompt: vi.fn(),
    setLanguage: vi.fn(),
    dispose: vi.fn(),
  } satisfies RecordingSessionClient;
  return {
    client,
    record(recordingId: string | null) {
      snapshot = { ...snapshot, recordingId };
      listeners.forEach(listener => listener());
    },
    finish(next: Completion) {
      snapshot = { ...snapshot, completedRecording: next };
      listeners.forEach(listener => listener());
    },
  };
}
function wrapper() {
  const queryClient = new QueryClient();
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </React.StrictMode>
    );
  }
  return Wrapper;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('recording completion binding', () => {
  it('binds a delayed panel language change to the initiating recording', async () => {
    const { client, record } = makeClient(null);
    record('first');
    const { result } = renderHook(() => useWorkflowRecording(client), { wrapper: wrapper() });
    const delayedChange = result.current.setLanguage;
    act(() => record('second'));
    await delayedChange('hi');
    expect(client.setLanguage).not.toHaveBeenCalled();
    await result.current.setLanguage('de');
    expect(client.setLanguage).toHaveBeenCalledWith('de');
  });

  it('does not apply a choice made while idle to a recording that starts later', async () => {
    const { client, record } = makeClient(null);
    const { result } = renderHook(() => useWorkflowRecording(client), { wrapper: wrapper() });
    const delayedChange = result.current.setLanguage;
    act(() => record('new'));
    await delayedChange('hi');
    expect(client.setLanguage).not.toHaveBeenCalled();
  });

  it('does not replay completion or automatic enhancement after a hook remount', () => {
    const { client } = makeClient(completion('rec', 'workflow'));
    const Wrapper = wrapper();
    const first = renderHook(() => useWorkflowRecording(client), { wrapper: Wrapper });
    expect(spies.capture).toHaveBeenCalledOnce();
    expect(spies.enhance).toHaveBeenCalledOnce();
    first.unmount();
    renderHook(() => useWorkflowRecording(client), { wrapper: Wrapper });
    expect(spies.capture).toHaveBeenCalledOnce();
    expect(spies.enhance).toHaveBeenCalledOnce();
  });

  it('handles a later recording once without suppressing the same controller', () => {
    const { client, finish } = makeClient(completion('first', 'workflow-one'));
    renderHook(() => useWorkflowRecording(client), { wrapper: wrapper() });
    act(() => finish(completion('second', 'workflow-two')));
    act(() => finish(completion('second', 'workflow-two')));
    expect(spies.capture).toHaveBeenCalledTimes(2);
    expect(spies.enhance).toHaveBeenCalledTimes(2);
    expect(spies.enhance).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordingId: 'second', workflowId: 'workflow-two' }),
      expect.any(Object)
    );
  });

  it('refreshes completed recording data without inventing an automatic skill reservation', () => {
    const { client } = makeClient(completion('manual'));
    renderHook(() => useWorkflowRecording(client), { wrapper: wrapper() });
    expect(spies.capture).toHaveBeenCalledOnce();
    expect(spies.enhance).not.toHaveBeenCalled();
  });
});
