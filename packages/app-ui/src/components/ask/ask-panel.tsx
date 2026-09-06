'use client';

import * as React from 'react';
import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import { SquarePen } from 'lucide-react';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '../../ui/message-scroller';
import { Marker, MarkerContent, MarkerIcon } from '../../ui/marker';
import { Button } from '../../ui/button';
import { Loader } from '../ai-elements/loader';
import { DockPanelAction, DockPanelActions } from '../dock-panel-actions';
import { DOCK_SCROLL_BUTTON } from '../dock-chrome';
import { formatSessionTimer } from '../note-recording-dock';
import { AskComposer, type AskComposerHandle, type ComposerSkill } from './ask-composer';
import { AskMessage } from './ask-message';
import { AskSkillRunTurn } from './ask-skill-run-turn';
import { AskSuggestions } from './ask-suggestions';
import { useSkillRunActivityStore, useSkillRuns, type SkillRunRecord } from '@prismical/app-client';
import { useLatestConversation } from '@prismical/app-client';
import { useActiveOrgId, useActiveSessionKey } from '@prismical/app-client';
import { askHeadersForPlatform, createAskTransport } from '@prismical/app-client';
import { mintConversationId, toUiMessages, type AskStoredMessage } from '@prismical/app-client';
import { contextToScope, uiMessageText, type AskContextItem } from '@prismical/app-client';
import { useDesktopCapabilities, useInstances } from '@prismical/app-client';
import {
  AUTO_SELECTION,
  buildAskModelGroups,
  loadModelPref,
  resolveActiveModel,
  saveModelPref,
  type AskModelSelection,
} from '@prismical/app-client';
import { EVENTS, usePorts, useNavigation } from '@prismical/app-client';
import {
  AskSessionChangedError,
  askNoticeOf,
  askStreamFailureOf,
  bindAiErrorActions,
  isAuto,
  isNetworkFailure,
  type AiUserErrorAction,
} from '@prismical/app-client';
import { Info, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { STATUS_LINK } from './ask-skill-run-turn-styles';
import { useTranslation } from 'react-i18next';
import { AppLink as Link } from '../../shell/app-link';

/**
 * The Ask AI chat panel. Loads the caller's latest persisted conversation and resumes
 * it; "New chat" mints a fresh conversation. The header (collapse + New chat) stays mounted while the
 * inner {@link AskChat} — which owns the live `useChat` session — remounts (keyed by conversation id)
 * whenever the active conversation changes, so each thread starts from a clean hook state.
 */
/**
 * A streamed `error` part's text, when the producer wrote an actionable one
 * (the desktop's local lane: "add an API key…"). Core masks provider errors
 * behind the AI SDK's generic "An error occurred." — that one stays on the
 * localized fallback.
 */
function streamErrorText(error: unknown): string | null {
  const text = error instanceof Error ? error.message.trim() : '';
  if (text.length === 0 || /^an error occurred\.?$/i.test(text)) return null;
  return text;
}

/** What the failed row shows: a title, an optional second line, and the actions the user can take. */
interface AskFailure {
  title: string;
  body?: string;
  actions: AiUserErrorAction[];
}

/**
 * Describe a failed Ask turn for the user. Core renders the copy + recovery actions for anything
 * that reached it (`describeAiError`, carried inside the stream's error part); the client only
 * binds the action kinds it can perform. The remaining branches cover failures that never got a
 * server answer: the login owner changed mid-request, the network was down, or an older producer
 * (the desktop's local lane) wrote plain prose.
 */
function describeAskFailure(
  error: unknown,
  emptyAnswer: boolean,
  t: (key: string) => string,
  handlers: Partial<Record<string, () => void>>
): AskFailure {
  const retryOnly = bindAiErrorActions(
    [{ kind: 'retry', label: t('common.actions.retry') }],
    handlers
  );
  const failure = askStreamFailureOf(error);
  if (failure?.user) {
    return {
      title: failure.user.title,
      body: failure.user.body,
      actions: bindAiErrorActions(failure.user.actions, handlers),
    };
  }
  // An envelope with no user block: never echo its JSON.
  if (failure) return { title: t('ask.error'), actions: retryOnly };
  if (error instanceof AskSessionChangedError) {
    return { title: t('ask.errors.sessionChanged'), actions: retryOnly };
  }
  if (isNetworkFailure(error)) {
    return {
      title: t('ask.errors.offline'),
      body: t('ask.errors.offlineBody'),
      actions: retryOnly,
    };
  }
  if (emptyAnswer && !error) return { title: t('ask.noResponse'), actions: retryOnly };
  return { title: streamErrorText(error) ?? t('ask.error'), actions: retryOnly };
}

/** The server's action links (dock v3 status-link style), first one as the primary button. */
function AskFailureActions({ actions }: { actions: AiUserErrorAction[] }) {
  const [primary, ...rest] = actions;
  return (
    <>
      {primary && (
        <Button type="button" size="xs" variant="outline" onClick={primary.onClick}>
          {primary.label}
        </Button>
      )}
      {rest.map(a => (
        <button key={a.kind} type="button" onClick={a.onClick} className={STATUS_LINK}>
          {a.label}
        </button>
      ))}
    </>
  );
}

/** The stale model pick already announced this page load (survives New chat remounts). */
let fallbackToastedFor: string | null = null;

export function AskPanel({
  open,
  isMaximized,
  onToggleMaximized,
  onClose,
  recordingActive = false,
  recordingPaused = false,
  recordingSeconds = 0,
  onShowRecording,
  onRunSkill,
  noteId = null,
  compact = false,
  askAllowed = true,
}: {
  open: boolean;
  isMaximized: boolean;
  onToggleMaximized: () => void;
  onClose: () => void;
  /**
   * Plan gate (client half): false replaces the composer with an upgrade hint. The thread itself
   * stays — skill runs render there and are gated by credits, not by Ask. The server refuses an
   * Ask turn with ASK_NOT_IN_PLAN regardless.
   */
  askAllowed?: boolean;
  /** A live session is running while Ask is open — the action cluster pins a
   * recording-continues chip (dot + timer) so the session never loses signal
   * behind the collapsed Record unit. */
  recordingActive?: boolean;
  recordingPaused?: boolean;
  recordingSeconds?: number;
  /** Chip click: hand the dock back to the Record unit. */
  onShowRecording?: () => void;
  /** Run a `/skill` composer send against the current note; absent off-note. */
  onRunSkill?: (skill: ComposerSkill, instruction: string) => void;
  /** The note in focus — its skill runs render as turns in the thread (run feed). */
  noteId?: string | null;
  /** Narrow surface (float window) — forwarded to the composer. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const { data: latest, isLoading } = useLatestConversation();
  const activeOrgId = useActiveOrgId();
  const activeSessionKey = useActiveSessionKey();

  // The active conversation: id + the messages to seed the chat with. Null until the latest thread
  // resolves (or we mint a fresh id for a first-time user).
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [seed, setSeed] = React.useState<AskStoredMessage[]>([]);
  const [chatSessionKey, setChatSessionKey] = React.useState<string | null>(null);
  const [chatOrgId, setChatOrgId] = React.useState<string | null>(null);

  // The live `useChat` thread is in-memory React state, NOT React Query — so the
  // cache reset can't clear it. On a real account OR organization switch, drop the
  // thread so the adoption effect below re-runs and picks up the NEW context's
  // latest conversation. Mirrors OrgScopedCacheReset: account change always resets
  // (different user); an org change skips the null→default hydration.
  const prevCtx = React.useRef<string>(`${activeSessionKey ?? ''}::${activeOrgId ?? ''}`);
  React.useEffect(() => {
    const key = `${activeSessionKey ?? ''}::${activeOrgId ?? ''}`;
    const from = prevCtx.current;
    prevCtx.current = key;
    if (from === key || activeSessionKey == null) return;
    const sessionChanged = from.split('::')[0] !== activeSessionKey;
    if (!sessionChanged && activeOrgId == null) return; // org not resolved yet
    setChatId(null);
    setSeed([]);
    setChatSessionKey(null);
    setChatOrgId(null);
  }, [activeSessionKey, activeOrgId]);

  // Adopt the latest persisted thread once it loads; a first-time user (or a load error) starts a
  // fresh conversation. Guarded by `chatId` so it runs exactly once.
  React.useEffect(() => {
    if (chatId || isLoading || !activeSessionKey) return;
    if (latest) {
      setChatId(latest.id);
      setSeed(latest.messages);
    } else {
      setChatId(mintConversationId());
      setSeed([]);
    }
    setChatSessionKey(activeSessionKey);
    setChatOrgId(activeOrgId);
  }, [latest, isLoading, chatId, activeSessionKey, activeOrgId]);

  const focusComposer = React.useCallback(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('.ask-composer-input')
      ?.focus({ preventScroll: true });
  }, []);

  // Start a new conversation: mint a fresh id (new server row on first save) and clear the thread.
  const newChat = React.useCallback(() => {
    if (!activeSessionKey) return;
    setSeed([]);
    setChatId(mintConversationId());
    setChatSessionKey(activeSessionKey);
    setChatOrgId(activeOrgId);
    requestAnimationFrame(focusComposer);
  }, [activeOrgId, activeSessionKey, focusComposer]);

  // Focus the composer when the panel opens (or once the chat first mounts) so the user can type
  // immediately. The panel is always mounted, so we key on the closed→open transition + chat id.
  React.useEffect(() => {
    if (open && chatId) focusComposer();
  }, [open, chatId, focusComposer]);

  return (
    // Fills the Ask unit's panel face: headerless — the unit is the card, and
    // New chat rides in the hover-revealed action cluster next to maximize/collapse.
    <div ref={rootRef} className="relative flex h-full w-full flex-col">
      <DockPanelActions
        isMaximized={isMaximized}
        onToggleMaximized={onToggleMaximized}
        collapseLabel={t('ask.collapse')}
        onCollapse={onClose}
        forceVisible={recordingActive}
      >
        {recordingActive ? (
          // Recording-continues chip: the Record unit is collapsed while Ask is
          // expanded, so this is the session's only signal — always visible
          // (forceVisible), and a click hands the dock back to the recording.
          <button
            type="button"
            onClick={onShowRecording}
            className="mr-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-rec-soft px-2 text-xs font-medium tabular-nums text-rec"
            aria-label={t('recording.actions.showTranscription')}
          >
            <span
              className={`size-[7px] rounded-full bg-rec ${
                recordingPaused ? 'opacity-50' : 'animate-pulse motion-reduce:animate-none'
              }`}
            />
            {formatSessionTimer(recordingSeconds)}
          </button>
        ) : null}
        <DockPanelAction label={t('ask.newChat')} onClick={newChat}>
          <SquarePen className="size-[15px]" />
        </DockPanelAction>
      </DockPanelActions>

      {chatId &&
      chatSessionKey === activeSessionKey &&
      chatOrgId === activeOrgId &&
      activeSessionKey ? (
        <AskChat
          key={`${activeSessionKey}:${activeOrgId ?? ''}:${chatId}`}
          conversationId={chatId}
          initialMessages={seed}
          ownerSessionKey={activeSessionKey}
          ownerOrgId={activeOrgId}
          onRunSkill={onRunSkill}
          noteId={noteId}
          onReviewInNote={onClose}
          compact={compact}
          askAllowed={askAllowed}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader size={16} />
        </div>
      )}
    </div>
  );
}

/**
 * Every item in the Ask scroller MUST opt out of deferred offscreen rendering: turns scroll to
 * MEASURED positions, and `content-visibility: auto` makes unrendered items report the 10rem
 * estimate instead of their real height, landing the viewport hundreds of px off the anchor.
 * One wrapper so a future item type can't silently reintroduce the bug.
 */
function AskScrollerItem(props: React.ComponentProps<typeof MessageScrollerItem>) {
  return <MessageScrollerItem deferOffscreenRendering={false} {...props} />;
}

/**
 * One Ask AI chat session, bound to a single `conversationId`. Hosts a `useChat` pointed at the core
 * `/me/ask` stream via a custom transport that reshapes the request, reads the latest context-chip
 * scope on each send, and tags the request with the conversation id so the server persists the turn.
 * Seeded with `initialMessages` (the resumed thread). Remounted (via `key`) whenever the conversation
 * changes, so the hook state never bleeds between threads.
 */
function AskChat({
  conversationId,
  initialMessages,
  ownerSessionKey,
  ownerOrgId,
  onRunSkill,
  noteId = null,
  onReviewInNote,
  compact = false,
  askAllowed = true,
}: {
  conversationId: string;
  initialMessages: AskStoredMessage[];
  ownerSessionKey: string;
  ownerOrgId: string | null;
  /** See `AskPanel.askAllowed`. */
  askAllowed?: boolean;
  onRunSkill?: (skill: ComposerSkill, instruction: string) => void;
  /** The note in focus — its skill runs render as turns in the thread. */
  noteId?: string | null;
  /** "Review in note" on a staged run: collapse the panel over the diff. */
  onReviewInNote?: () => void;
  /** Narrow surface (float window) — forwarded to the composer. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  // Per-send scope: @note tokens in the composer become the request's
  // scope. CONSUMED where it is read: the AI SDK invokes the transport's
  // prepare hook a couple of async boundaries after sendMessage returns, so a
  // clear-after-send in the submit handler would empty the ref before the
  // request ever read it — the getter takes the pending scope and resets it,
  // so it applies to exactly one request and never leaks into the next turn.
  const contextRef = React.useRef<AskContextItem[]>([]);
  // Product analytics via the injected AnalyticsPort.
  const { analytics, auth, env } = usePorts();
  const platform = env.getEnv().platform;

  // Model selection: groups built from the user's instances (Prismical Cloud → Auto + each
  // BYOK instance's curated models). The chosen pick is remembered in localStorage and validated
  // against the live groups every render — a deleted instance / removed model falls back to Auto.
  const caps = useDesktopCapabilities();
  const { data: instances = [] } = useInstances();
  const groups = React.useMemo(
    () =>
      buildAskModelGroups(
        instances,
        t('ask.models.auto'),
        // Local mode (the provider capability) runs Auto on the device's own
        // provider — never Prismical's managed cloud.
        caps.has('ai-provider') ? t('ask.models.thisDevice') : undefined
      ),
    [instances, t, caps]
  );
  const [model, setModel] = React.useState<AskModelSelection>(
    () => loadModelPref() ?? AUTO_SELECTION
  );
  const activeModel = React.useMemo(() => resolveActiveModel(groups, model), [groups, model]);
  const activeModelRef = React.useRef(activeModel);
  activeModelRef.current = activeModel;
  // "Use Prismical Cloud" on a failed turn: the NEXT request runs on Auto, once. The remembered
  // pick is untouched, so the turn after that is back on the user's own key.
  const cloudOnceRef = React.useRef(false);
  const chooseModel = React.useCallback((sel: AskModelSelection) => {
    setModel(sel);
    saveModelPref(sel);
  }, []);
  const navigation = useNavigation();

  // The remembered pick no longer resolves (instance deleted, model removed from its list): the
  // panel silently runs Auto. Say so once per stale pick, with a way to choose again — otherwise
  // the user believes their own key is answering when Prismical Cloud is.
  React.useEffect(() => {
    if (instances.length === 0 || isAuto(model) || !isAuto(activeModel)) return;
    const key = `${model.instanceId}:${model.modelId}`;
    if (fallbackToastedFor === key) return;
    fallbackToastedFor = key;
    toast.info(t('ask.errors.modelFallback'), {
      action: {
        label: t('ask.errors.chooseModel'),
        onClick: () => navigation.push('/settings/ai-models'),
      },
    });
  }, [instances.length, model, activeModel, t, navigation]);

  // The transport reads `contextRef`/`activeModelRef` at send time (freshest scope + model) and carries
  // the fixed conversation id.
  const transport = React.useMemo(
    () =>
      createAskTransport(
        () => {
          const scope = contextToScope(contextRef.current);
          contextRef.current = [];
          return scope;
        },
        conversationId,
        // Held for the whole `regenerate()` (which may chain a tool-approval resume request):
        // the flag is cleared when that settles, not on the first read.
        () => (cloudOnceRef.current ? AUTO_SELECTION : activeModelRef.current),
        () => askHeadersForPlatform(platform, auth, ownerSessionKey, ownerOrgId)
      ),
    [auth, conversationId, ownerOrgId, ownerSessionKey, platform]
  );
  // Seed the resumed thread. Stable per conversation id (the parent remounts us when it changes).
  const initial = React.useMemo(
    () => toUiMessages(initialMessages, conversationId),
    [initialMessages, conversationId]
  );
  const { messages, sendMessage, status, error, stop, regenerate, addToolApprovalResponse } =
    useChat({
      id: conversationId,
      messages: initial,
      transport,
      // Tool-approval resume: once every pending approval on the last assistant turn
      // has a response, auto-POST so the server re-runs and executes/denies the gated tools.
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });

  // Abort the stream and any scheduled approval resume when the exact login
  // owner changes. The bound transport independently rejects a late callback.
  const stopRef = React.useRef(stop);
  stopRef.current = stop;
  React.useEffect(
    () => () => {
      void stopRef.current();
    },
    []
  );

  // Per-conversation auto-approve set (the "don't ask again for this tool" checkbox) + a hard
  // budget so unattended approve→resume chains can't loop forever (a human re-enters the loop
  // once it's spent).
  const [autoApproved, setAutoApproved] = React.useState<ReadonlySet<string>>(new Set());
  const addAutoApproved = React.useCallback(
    (toolName: string) => setAutoApproved(prev => new Set([...prev, toolName])),
    []
  );
  const autoApproveBudget = React.useRef(20);
  const takeAutoApproval = React.useCallback(() => {
    if (autoApproveBudget.current <= 0) return false;
    autoApproveBudget.current -= 1;
    return true;
  }, []);

  const busy = status === 'submitted' || status === 'streaming';

  // In-flight + failure UX. While a request is in flight the assistant turn can have NO text yet
  // (request sent, or stream open before the first token) — show a "Thinking…" indicator instead of
  // a blank panel. If a request finishes with neither text nor an error (e.g. an empty 200 stream),
  // treat it as a soft failure so the user isn't left staring at nothing.
  const last = messages[messages.length - 1];
  const lastIsEmptyAssistant = last?.role === 'assistant' && uiMessageText(last).trim() === '';
  // A turn paused on a tool approval has no text yet but is NOT empty/failed — the approval card
  // is the content.
  const lastAwaitsApproval =
    last?.role === 'assistant' &&
    last.parts.some(
      p =>
        (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) &&
        (p as { state?: string }).state === 'approval-requested'
    );
  const lastHasToolActivity =
    last?.role === 'assistant' &&
    last.parts.some(p => p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
  const thinking =
    busy && (last?.role === 'user' || (lastIsEmptyAssistant && !lastHasToolActivity));
  // The server's per-turn notice (`message.metadata.notice`): the answer was cut off, the tool
  // loop ran dry, the turn fell back to Prismical Cloud. Rendered under the finished answer.
  const lastNotice = last?.role === 'assistant' ? askNoticeOf(last.metadata) : null;
  // A tool-only turn with no text used to read as "No response" — when the server explains it
  // (steps exhausted), the notice is the explanation and the generic line stays hidden.
  const emptyAnswer =
    status === 'ready' &&
    lastIsEmptyAssistant &&
    !lastAwaitsApproval &&
    !lastHasToolActivity &&
    !lastNotice;
  const failed = status === 'error' || Boolean(error) || emptyAnswer;
  const showNotice = status === 'ready' && !failed && !lastAwaitsApproval && lastNotice !== null;

  const failureHandlers = React.useMemo<Partial<Record<string, () => void>>>(
    () => ({
      retry: () => void regenerate().catch(() => {}),
      continue: () => void sendMessage({ text: t('ask.errors.continueMessage') }).catch(() => {}),
      // One-off: this turn on Prismical Cloud. The remembered pick is untouched.
      'use-cloud': () => {
        cloudOnceRef.current = true;
        // Every request `regenerate()` makes (including an approval resume) runs on Cloud; the
        // flag is dropped when it settles so it never leaks into the next question.
        regenerate()
          .catch(() => {})
          .finally(() => {
            cloudOnceRef.current = false;
          });
      },
      'choose-model': () => navigation.push('/settings/ai-models'),
      'open-ai-models': () => navigation.push('/settings/ai-models'),
      'open-billing': () => navigation.push('/settings/billing'),
    }),
    [regenerate, sendMessage, t, navigation]
  );
  const failure = React.useMemo(
    () => (failed ? describeAskFailure(error, emptyAnswer, t, failureHandlers) : null),
    [failed, error, emptyAnswer, t, failureHandlers]
  );
  const noticeActions = React.useMemo(
    () => (lastNotice ? bindAiErrorActions(lastNotice.actions, failureHandlers) : []),
    [lastNotice, failureHandlers]
  );

  // Skill runs as turns (dock v3, skills-in-Ask): the note's run feed renders inline. A record is
  // ANCHORED the first time this chat sees it — to this conversation and the message it follows —
  // so a later Q&A turn lands below it instead of the run sinking under every new message.
  // A record that SETTLED in another conversation stays there; one still running follows the user
  // into a new thread (New chat / org switch mid-run) so its Stop is never stranded off-screen.
  const runs = useSkillRuns(noteId);
  const anchorRun = useSkillRunActivityStore(s => s.anchor);
  const lastIdRef = React.useRef<string>('');
  lastIdRef.current = last?.id ?? '';
  React.useEffect(() => {
    for (const r of runs) {
      // Unanchored, or still running in a thread the user just left (New chat / org switch
      // remounted us): it follows the user here. Settled records keep their thread.
      const stale =
        r.anchor && r.anchor.conversationId !== conversationId && r.status === 'running';
      if (!r.anchor || stale) {
        anchorRun(r.id, { conversationId, afterMessageId: lastIdRef.current });
      }
    }
  }, [runs, conversationId, anchorRun]);
  const messageIds = React.useMemo(() => new Set(messages.map(m => m.id)), [messages]);
  const runsAfter = React.useMemo(() => {
    const map = new Map<string, SkillRunRecord[]>();
    for (const r of runs) {
      let key: string | null;
      if (!r.anchor || (r.anchor.conversationId !== conversationId && r.status === 'running')) {
        // Not yet (re)anchored — first render after it appeared: follows the current last message.
        key = lastIdRef.current;
      } else if (r.anchor.conversationId !== conversationId) {
        key = null; // settled in another conversation — not this thread's
      } else {
        // A regenerate re-ids the last assistant turn; a record anchored to the old id falls back
        // to the end of the thread rather than vanishing.
        key =
          r.anchor.afterMessageId === '' || messageIds.has(r.anchor.afterMessageId)
            ? r.anchor.afterMessageId
            : lastIdRef.current;
      }
      if (key === null) continue;
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  }, [runs, conversationId, messageIds]);
  const runTurns = (afterMessageId: string) =>
    (runsAfter.get(afterMessageId) ?? []).map(r => (
      <AskScrollerItem key={`run:${r.id}`} messageId={`run:${r.id}`} scrollAnchor>
        <AskSkillRunTurn run={r} onReviewInNote={onReviewInNote} />
      </AskScrollerItem>
    ));
  const hasRunTurns = runsAfter.size > 0;
  // The composer's send button becomes Stop for a run THIS composer started (chip / slash send —
  // the mock's streaming grammar); chat sends wait until it settles. Runs from other lanes
  // (wand, auto-enhance on stop, inline, refine) never lock the composer — auto-enhance can wait
  // on diarization for minutes — their Stop lives on the thread turn and the collapsed pill.
  const activeRun = React.useMemo(() => {
    const rendered = [...runsAfter.values()].flat();
    for (let i = rendered.length - 1; i >= 0; i--) {
      const r = rendered[i]!;
      if (r.status === 'running' && (r.source === 'composer' || r.source === 'chip')) return r;
    }
    return null;
  }, [runsAfter]);

  const composerRef = React.useRef<AskComposerHandle>(null);

  const onComposerSend = (text: string, notes: { id: string; title: string }[]) => {
    if (!text || busy) return;
    contextRef.current = notes.map(n => ({ kind: 'note' as const, id: n.id, label: n.title }));
    sendMessage({ text });
    analytics.capture(EVENTS.ASK_AI_MESSAGE_SENT, {
      conversation_id: conversationId,
      has_context: notes.length > 0,
    });
  };

  // Suggestion sends: empty-state starter questions and per-answer follow-up chips both
  // send immediately, optionally scoped to notes (a starter about "this note"
  // attaches the open note the same way an @-token would).
  const sendSuggested = React.useCallback(
    (
      text: string,
      opts: { source: 'starter' | 'followup'; notes?: { id: string; title: string }[] }
    ) => {
      if (!text || busy) return;
      const notes = opts.notes ?? [];
      contextRef.current = notes.map(n => ({ kind: 'note' as const, id: n.id, label: n.title }));
      void sendMessage({ text });
      analytics.capture(EVENTS.ASK_AI_MESSAGE_SENT, {
        conversation_id: conversationId,
        has_context: notes.length > 0,
        suggestion_source: opts.source,
      });
    },
    [busy, sendMessage, analytics, conversationId]
  );

  // The scroller only treats wheel/touch/scroll-keys as user intent, so a scrollbar drag would
  // fight the anchored turn's re-anchor on every stream resize. A pointerdown whose
  // target is the viewport element itself is the scrollbar/gutter (content clicks target a
  // descendant); re-dispatch it as an upward wheel so the primitive's own intent path releases the
  // anchor. deltaY -1, not 0: untrusted events never actually scroll, but a real (non-no-op) delta
  // survives a future library guard against zero-delta wheels.
  const releaseAnchorOnScrollbarDrag = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true })
        );
      }
    },
    []
  );

  return (
    <>
      {/* ph-mask-content: Ask-AI message text is masked in session recordings. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="flex-1 ph-mask-content">
          <MessageScrollerViewport
            aria-label={t('ask.conversation')}
            onPointerDown={releaseAnchorOnScrollbarDrag}
          >
            <MessageScrollerContent aria-busy={busy} className="gap-[18px] p-4">
              {messages.length === 0 && !hasRunTurns ? (
                <AskScrollerItem className="flex min-h-full flex-1">
                  {/* Empty state: everything left-aligned at the bottom, next to
                      where the composer sits — title, then starter-question chips (send
                      immediately) over skill chips (stage a token / fill the composer). */}
                  <div className="flex flex-1 flex-col items-start justify-end gap-2 pb-1">
                    <p className="text-[13.5px] font-semibold text-dock-ink">{t('ask.empty')}</p>
                    <AskSuggestions
                      canRunSkills={Boolean(onRunSkill)}
                      onAsk={(question, notes) =>
                        sendSuggested(question, { source: 'starter', notes })
                      }
                      onPickPrompt={prompt => {
                        composerRef.current?.setText(prompt);
                        composerRef.current?.focus();
                      }}
                      onInsertSkill={skill => {
                        composerRef.current?.insertSkill(skill);
                      }}
                    />
                  </div>
                </AskScrollerItem>
              ) : (
                <>
                  {runTurns('')}
                  {messages.map(m => (
                    <React.Fragment key={m.id}>
                      <AskScrollerItem messageId={m.id} scrollAnchor={m.role === 'user'}>
                        <AskMessage
                          message={m}
                          streaming={busy && m === last}
                          isLast={m === last}
                          busy={busy}
                          onRegenerate={() => regenerate()}
                          // No notes attached — deliberate: scope is per-send everywhere (a composer
                          // send only scopes its own @-tokens too), and the prior turn's content is
                          // already in the conversation the model sees.
                          onFollowup={q => sendSuggested(q, { source: 'followup' })}
                          approval={{
                            respond: addToolApprovalResponse,
                            autoApproved,
                            addAutoApproved,
                            takeAutoApproval,
                          }}
                        />
                      </AskScrollerItem>
                      {runTurns(m.id)}
                    </React.Fragment>
                  ))}
                </>
              )}
              {thinking && (
                <AskScrollerItem messageId={`${conversationId}-thinking`}>
                  <Marker className="w-fit" role="status">
                    <MarkerIcon>
                      <Loader size={14} />
                    </MarkerIcon>
                    <MarkerContent className="shimmer shimmer-duration-1400 text-dock-ink-3">
                      {t('ask.thinking')}
                    </MarkerContent>
                  </Marker>
                </AskScrollerItem>
              )}
              {failure && !thinking && (
                <AskScrollerItem messageId={`${conversationId}-failed`}>
                  <div className="mr-auto flex flex-col gap-1 py-1 text-sm" role="alert">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-destructive">{failure.title}</span>
                      <AskFailureActions actions={failure.actions} />
                    </div>
                    {failure.body && (
                      <span className="text-xs text-dock-ink-3">{failure.body}</span>
                    )}
                  </div>
                </AskScrollerItem>
              )}
              {showNotice && lastNotice && (
                <AskScrollerItem messageId={`${conversationId}-notice`}>
                  <Marker className="w-fit" role="status">
                    <MarkerIcon>
                      {lastNotice.severity === 'info' ? (
                        <Info className="size-[14px]" />
                      ) : (
                        <TriangleAlert className="size-[14px]" />
                      )}
                    </MarkerIcon>
                    <MarkerContent className="flex flex-col gap-0.5 text-xs text-dock-ink-3">
                      <span>{lastNotice.title}</span>
                      {lastNotice.body && <span>{lastNotice.body}</span>}
                      {noticeActions.length > 0 && (
                        <span className="flex flex-wrap items-center gap-2 pt-0.5">
                          {noticeActions.map(a => (
                            <button
                              key={a.kind}
                              type="button"
                              onClick={a.onClick}
                              className={STATUS_LINK}
                            >
                              {a.label}
                            </button>
                          ))}
                        </span>
                      )}
                    </MarkerContent>
                  </Marker>
                </AskScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          {/* Dock-token styling with right alignment. */}
          <MessageScrollerButton className={DOCK_SCROLL_BUTTON} />
        </MessageScroller>
      </MessageScrollerProvider>

      {askAllowed ? (
        <AskComposer
          ref={composerRef}
          compact={compact}
          busy={busy || activeRun !== null}
          onSend={onComposerSend}
          onRunSkill={onRunSkill}
          // A chat stream and a composer-started run can overlap; Stop settles the stream first.
          onStop={() => (busy ? void stop() : activeRun?.cancel?.())}
          modelGroups={groups}
          modelValue={activeModel}
          onModelChange={chooseModel}
        />
      ) : (
        <div className="border-t border-border/60 px-4 py-3 text-sm">
          <p className="font-medium">{t('settings.billing.screen.gateAskAiTitle')}</p>
          <p className="text-muted-foreground">
            {t('settings.billing.screen.gateAskAiDescription')}
          </p>
          <Link
            href="/settings/billing"
            className="mt-1 inline-block font-medium text-primary hover:underline"
          >
            {t('settings.billing.screen.gateSeePlans')}
          </Link>
        </div>
      )}
    </>
  );
}
