// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { AskComposer } from './ask-composer';
import type { AskMessage } from './ask-message';
import { createWorkflowRuntime } from '../../../../app-workflow/src/runtime';

const mocks = vi.hoisted(() => ({
  currentNote: { noteId: 'current-note', title: 'Current note' } as { noteId: string; title: string } | null,
  workflow: undefined! as ReturnType<typeof createWorkflowRuntime>,
  chatOptions: undefined! as { sendAutomaticallyWhen: (options: { messages: unknown[] }) => boolean },
  composer: undefined! as React.ComponentProps<typeof AskComposer>,
  message: undefined! as React.ComponentProps<typeof AskMessage>,
  assertCanSend: undefined as (() => void) | undefined,
  send: vi.fn(async () => {}),
  regenerate: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  approve: vi.fn(async () => {}),
  status: 'ready',
  empty: [] as never[],
  messages: [{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] }] as UIMessage[],
}));

vi.mock('../../shell/current-note-context', () => ({ useCurrentNote: () => ({ currentNote: mocks.currentNote }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@ai-sdk/react', () => ({
  useChat: (options: typeof mocks.chatOptions) => {
    mocks.chatOptions = options;
    return {
      messages: mocks.messages,
      status: mocks.status,
      sendMessage: mocks.send,
      regenerate: mocks.regenerate,
      stop: mocks.stop,
      addToolApprovalResponse: mocks.approve,
    };
  },
}));
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithApprovalResponses: () => true }));
vi.mock('@prismical/app-client', async () => {
  const { canAsk } = await import('../../../../app-workflow/src/machine');
  const { contextToScope } = await import('../../../../app-client/src/ask/scope');
  const { askOriginScope, askContinuationMessage } = await import('../../../../app-client/src/ask/conversation');
  const wrapper = { data: { id: 'conversation', messages: [] }, isLoading: false };
  return {
    canAsk,
    useWorkflowSnapshot: () =>
      React.useSyncExternalStore(mocks.workflow.subscribe, mocks.workflow.getSnapshot),
    useLatestConversation: () => wrapper,
    useActiveOrgId: () => 'org',
    useActiveSessionKey: () => 'session',
    usePorts: () => ({
      workflow: mocks.workflow,
      analytics: { capture: vi.fn() },
      auth: {},
      env: { getEnv: () => ({ platform: 'web' }) },
    }),
    useDesktopCapabilities: () => new Set(),
    useInstances: () => ({ data: mocks.empty }),
    useNavigation: () => ({ push: vi.fn() }),
    useEntitlements: () => ({ entitlements: { features: { askAi: true } } }),
    useSkillRuns: () => mocks.empty,
    useSkillRunActivityStore: () => vi.fn(),
    buildAskModelGroups: () => mocks.empty,
    loadModelPref: () => null,
    resolveActiveModel: (_groups: unknown, model: unknown) => model,
    saveModelPref: vi.fn(),
    AUTO_SELECTION: {},
    isAuto: () => true,
    mintConversationId: () => 'new-conversation',
    toUiMessages: () => mocks.messages,
    uiMessageText: () => 'Answer',
    contextToScope,
    askOriginScope,
    askContinuationMessage,
    askHeadersForPlatform: async () => ({}),
    createAskTransport: (_scope: unknown, _id: unknown, _model: unknown, _headers: unknown, guard: () => void) => {
      mocks.assertCanSend = guard;
      return {};
    },
    EVENTS: {},
    reportAskError: vi.fn(),
    askNoticeOf: () => null,
    askStreamFailureOf: () => null,
    bindAiErrorActions: () => [],
    isNetworkFailure: () => false,
    AskSessionChangedError: class extends Error {},
  };
});
vi.mock('../../ui/message-scroller', () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return Object.fromEntries(
    [
      'MessageScroller',
      'MessageScrollerContent',
      'MessageScrollerItem',
      'MessageScrollerProvider',
      'MessageScrollerViewport',
      'MessageScrollerButton',
    ].map(key => [key, Wrapper])
  );
});
vi.mock('../dock-panel-actions', () => ({
  DockPanelActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DockPanelAction: () => null,
}));
vi.mock('../note-recording-dock', () => ({ formatSessionTimer: () => '' }));
vi.mock('./ask-composer', () => ({
  AskComposer: React.forwardRef<never, React.ComponentProps<typeof AskComposer>>(function MockComposer(_props, _ref) {
    mocks.composer = _props;
    const [draft, setDraft] = React.useState('');
    return <><input aria-label="Draft question" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => _props.onSend('Question', [])}>Send question</button></>;
  }),
}));
vi.mock('./ask-message', () => ({
  AskMessage: (props: React.ComponentProps<typeof AskMessage>) => {
    mocks.message = props;
    return <button onClick={props.onRegenerate}>Regenerate</button>;
  },
}));
vi.mock('./ask-skill-run-turn', () => ({ AskSkillRunTurn: () => null }));
vi.mock('./ask-suggestions', () => ({ AskSuggestions: () => null }));

const { AskPanel } = await import('./ask-panel');
const panel = () => (
  <AskPanel
    open
    isMaximized={false}
    onToggleMaximized={() => {}}
    onClose={() => {}}
    noteId="current-note"
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workflow = createWorkflowRuntime();
  mocks.status = 'ready';
  mocks.currentNote = { noteId: 'current-note', title: 'Current note' };
  mocks.messages = [{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] }];
});
afterEach(cleanup);

function startSkill() {
  mocks.workflow.dispatch({
    type: 'runSkill',
    workflowId: 'wf',
    noteId: 'another-note',
    skillId: 'skill',
  });
}
function review() {
  mocks.workflow.dispatch({
    type: 'proposalReady',
    workflowId: 'wf',
    attempt: 1,
    proposalId: 'proposal',
  });
}

describe('Ask panel workflow admission', () => {
  it('keeps follow-up scope on its original question after navigation and blocks it during review', () => {
    mocks.messages = [
      { id: 'question', role: 'user', metadata: { scope: { noteIds: ['original-note'] } }, parts: [{ type: 'text', text: 'Question' }] },
      { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] },
    ];
    startSkill();
    const view = render(panel());
    mocks.currentNote = { noteId: 'other-note', title: 'Other note' };
    view.rerender(panel());
    const followup = mocks.message.onFollowup!;
    followup('More details');
    expect(mocks.send).toHaveBeenCalledWith({ text: 'More details', metadata: { scope: { noteIds: ['original-note'] } } });
    mocks.send.mockClear();
    act(review);
    followup('Late details');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('retains the mounted composer and draft while another note is reviewed', () => {
    startSkill();
    render(panel());
    const draft = screen.getByRole('textbox', { name: 'Draft question' });
    fireEvent.change(draft, { target: { value: 'My unfinished question' } });
    act(review);
    expect(screen.queryByRole('textbox', { name: 'Draft question' })).toBeNull();
    expect(draft.isConnected).toBe(true);
    expect(mocks.composer.canSubmit!()).toBe(false);
    act(() => mocks.workflow.dispatch({ type: 'declineProposal', workflowId: 'wf', proposalId: 'proposal' }));
    expect(screen.getByRole('textbox', { name: 'Draft question' })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('My unfinished question');
    expect(mocks.composer.canSubmit!()).toBe(true);
  });

  it('allows ordinary questions while recording and during an initial skill run', () => {
    mocks.workflow.dispatch({ type: 'startRecording', workflowId: 'wf', noteId: 'another-note' });
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    expect(mocks.send).toHaveBeenCalledWith({ text: 'Question', metadata: { scope: { noteIds: ['current-note'] } } });
    expect(() => mocks.assertCanSend?.()).not.toThrow();
    act(() => {
      mocks.workflow.dispatch({
        type: 'recordingFailed',
        workflowId: 'wf',
        attempt: 1,
        captureClosed: true,
      });
      startSkill();
    });
    expect(screen.getByRole('button', { name: 'Send question' })).toBeTruthy();
    expect(() => mocks.assertCanSend?.()).not.toThrow();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it('stops a stream for review on another note and fences stale sends, regeneration and tool resumes', async () => {
    startSkill();
    mocks.status = 'streaming';
    render(panel());
    const staleComposer = mocks.composer;
    const staleMessage = mocks.message;
    const autoResume = mocks.chatOptions.sendAutomaticallyWhen;
    expect(autoResume({ messages: [] })).toBe(true);
    act(review);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Send question' })).toBeNull();
    expect(() => mocks.assertCanSend?.()).toThrow('Ask paused for proposal review');
    staleComposer.onSend('Late question', []);
    await staleMessage.onRegenerate!();
    staleMessage.approval!.respond({ id: 'approval', approved: true });
    expect(staleMessage.approval!.takeAutoApproval()).toBe(false);
    expect(autoResume({ messages: [] })).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    act(() =>
      mocks.workflow.dispatch({ type: 'refineSkill', workflowId: 'wf', proposalId: 'proposal' })
    );
    expect(screen.queryByRole('button', { name: 'Send question' })).toBeNull();
    expect(() => mocks.assertCanSend?.()).toThrow();
    act(() => mocks.workflow.dispatch({ type: 'skillCancelled', workflowId: 'wf', attempt: 2 }));
    // Canceling refinement preserves the original proposal and its review ownership.
    expect(screen.queryByRole('button', { name: 'Send question' })).toBeNull();
    act(() =>
      mocks.workflow.dispatch({ type: 'declineProposal', workflowId: 'wf', proposalId: 'proposal' })
    );
    expect(screen.getByRole('button', { name: 'Send question' })).toBeTruthy();
    expect(() => mocks.assertCanSend?.()).not.toThrow();
  });
});
