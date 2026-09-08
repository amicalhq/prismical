'use client';

import * as React from 'react';
import {
  useActiveAccountId,
  useActiveOrgId,
  useActiveSessionKey,
  useEnv,
  useNavigation,
  usePathname,
  useNotes,
  usePorts,
  useSyncStore,
  useSkillDiffStore,
  useAutoEnhanceStore,
  EVENTS,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { replayAvailable } from './replay';
import { WalkthroughContext, WalkthroughStageContext } from './context';
import { AnchoredTour } from './anchored-tour';
import { OnboardingWelcomeDialog } from './welcome-dialog';
import { OnboardingCompletionDialog } from './completion-dialog';
import {
  advanceWalkthrough,
  readWalkthrough,
  walkthroughKey,
  writeWalkthrough,
  type Walkthrough,
  type WalkthroughEvent,
} from './state';
import { celebrateOnboarding } from './confetti';

const ReplayContext = React.createContext<(() => void) | null>(null);
export function FirstNoteWalkthroughReplay({
  onReplay,
  compact = false,
}: { onReplay?: () => void; compact?: boolean } = {}) {
  const restart = React.useContext(ReplayContext);
  const { t } = useTranslation();
  if (!restart) return null;
  return (
    <button
      type="button"
      onClick={() => {
        restart();
        onReplay?.();
      }}
      className={`mx-2 mb-2 inline-flex h-9 min-w-0 ${compact ? 'w-fit self-start' : 'self-stretch'} items-center gap-2 rounded-md border border-sidebar-border bg-transparent px-3 text-left text-sm text-sidebar-foreground motion-safe:transition-colors hover:border-indigo-400/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Play aria-hidden="true" className="size-4 text-indigo-500 dark:text-indigo-400" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{t('onboarding.replayTitle')}</span>
        <span className="sr-only">{t('onboarding.replayBody')}</span>
      </span>
    </button>
  );
}

export function FirstNoteWalkthroughProvider({
  children,
  enabled,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  const user = useActiveAccountId();
  const org = useActiveOrgId();
  const session = useActiveSessionKey();
  const { platform } = useEnv();
  const scope = (enabled ?? platform === 'web') && user && org ? `${session}:${org}` : null;
  const handlers = React.useRef<{
    notify: (event: WalkthroughEvent) => void;
    restart: () => void;
  } | null>(null);
  const [published, setPublished] = React.useState<{
    scope: string;
    active: Extract<Walkthrough, { status: 'active' }> | null;
    canReplay: boolean;
  } | null>(null);
  const publish = React.useCallback((next: NonNullable<typeof published>) => {
    setPublished(previous =>
      previous?.scope === next.scope &&
      previous.active === next.active &&
      previous.canReplay === next.canReplay
        ? previous
        : next
    );
  }, []);
  const notify = React.useCallback(
    (event: WalkthroughEvent) => handlers.current?.notify(event),
    []
  );
  const restart = React.useCallback(() => handlers.current?.restart(), []);
  const current = published?.scope === scope ? published : null;
  // Keep the shell at the same React position while identity resolves. Only the
  // tour controller resets on a workspace/session switch, never its consumers.
  return (
    <WalkthroughContext.Provider value={notify}>
      <ReplayContext.Provider value={current?.canReplay ? restart : null}>
        <WalkthroughStageContext.Provider value={current?.active ?? null}>
          {children}
          {scope && user && org ? (
            <ScopedWalkthrough
              key={scope}
              scope={scope}
              user={user}
              org={org}
              handlers={handlers}
              publish={publish}
            />
          ) : null}
        </WalkthroughStageContext.Provider>
      </ReplayContext.Provider>
    </WalkthroughContext.Provider>
  );
}

function ScopedWalkthrough({
  user,
  org,
  scope,
  handlers,
  publish,
}: {
  user: string;
  org: string;
  scope: string;
  handlers: React.RefObject<{
    notify: (event: WalkthroughEvent) => void;
    restart: () => void;
  } | null>;
  publish: (next: {
    scope: string;
    active: Extract<Walkthrough, { status: 'active' }> | null;
    canReplay: boolean;
  }) => void;
}) {
  const key = walkthroughKey(user);
  const [state, setState] = React.useState<Walkthrough | null>(null);
  const [doneOpen, setDoneOpen] = React.useState(false);
  const [canReplay, setCanReplay] = React.useState(false);
  const live = React.useRef(false);
  const storageFailed = React.useRef(false);
  const notes = useNotes();
  const store = useSyncStore();
  const navigation = useNavigation();
  const pathname = usePathname();
  const resumeNote = React.useRef<string | null>(null);
  const { auth, analytics } = usePorts();
  const track = React.useCallback(
    (event: string, props: Record<string, string | number | boolean | undefined> = {}) => {
      try {
        analytics.capture(event, { tour: 'first_note', tour_version: 1, org_id: org, ...props });
      } catch {
        /* Analytics must never interrupt the walkthrough. */
      }
    },
    [analytics, org]
  );
  const initialSession = useActiveSessionKey();
  const active = state?.status === 'active' && state.orgId === org ? state : null;
  const candidate = useSkillDiffStore(s =>
    active ? s.candidatesByNote.get(active.noteId) : undefined
  );
  const isCurrent = React.useCallback(() => {
    const session = auth.getSession();
    const account = session.accounts.find(
      a => (a.sessionKey ?? a.sub) === (session.activeSessionKey ?? session.activeSub)
    );
    return (
      live.current &&
      (session.activeSessionKey ?? session.activeSub) === initialSession &&
      account?.activeOrgId === org
    );
  }, [auth, initialSession, org]);

  React.useEffect(() => {
    live.current = true;
    const saved = readWalkthrough(key);
    setState(saved);
    resumeNote.current = saved?.status === 'active' && saved.orgId === org ? saved.noteId : null;
    const sync = (event: StorageEvent) => {
      if (event.key === `${key}:replay-retired`) setCanReplay(replayAvailable(key, 0));
      if (event.key === key || event.key === null)
        setState(readWalkthrough(key) ?? { status: 'dismissed' });
    };
    window.addEventListener('storage', sync);
    return () => {
      live.current = false;
      window.removeEventListener('storage', sync);
    };
  }, [key, org]);

  React.useEffect(() => {
    // Wait for the correctly scoped store's settled list. Never interpret a cold pull as empty.
    if (
      !notes.isSuccess ||
      !store ||
      store.partition.accountSub !== user ||
      store.partition.orgId !== org
    )
      return;
    setCanReplay(replayAvailable(key, notes.data?.length ?? 0));
    const saved = readWalkthrough(key);
    if (saved !== null) return;
    const account = auth.getSession().accounts.find(a => a.sub === user);
    const age = account?.signupAt ? Date.now() - Date.parse(account.signupAt) : NaN;
    const recentSignup = age >= 0 && age < 2 * 24 * 60 * 60 * 1000;
    const initial: Walkthrough = {
      status: !notes.data?.length && recentSignup ? 'offered' : 'dismissed',
    };
    const savedInitial = writeWalkthrough(key, initial);
    setState(savedInitial ? initial : { status: 'dismissed' });
  }, [notes.isSuccess, notes.data, store, user, org, key, auth]);

  React.useEffect(() => {
    // A persisted recording step belongs to its note, not the landing page after sign-in.
    // Resume once; later navigation must remain under the user's control.
    const noteId = resumeNote.current;
    if (!noteId || !notes.isSuccess || !isCurrent()) return;
    resumeNote.current = null;
    if (!notes.data?.some(note => note.id === noteId)) {
      writeWalkthrough(key, { status: 'dismissed' });
      setState({ status: 'dismissed' });
      return;
    }
    if (pathname !== `/notes/${noteId}`) navigation.replace(`/notes/${noteId}`);
  }, [notes.isSuccess, notes.data, key, pathname, navigation, isCurrent]);

  const notify = React.useCallback(
    (event: WalkthroughEvent) => {
      if (!isCurrent() || storageFailed.current) return;
      const previous = readWalkthrough(key);
      if (previous?.status === 'active' && previous.orgId !== org) return;
      if (event.type === 'error') {
        if (previous?.status !== 'active' && previous?.status !== 'offered') return;
        if (previous.status === 'active' && event.noteId && previous.noteId !== event.noteId)
          return;
        track(EVENTS.ONBOARDING_ERROR, {
          step: previous.status === 'active' ? previous.step : 'create',
          code: event.code,
        });
        return;
      }
      const next = advanceWalkthrough(previous, event, org);
      if (next === previous || !next) return;
      const saved = writeWalkthrough(key, next);
      if (!saved) {
        storageFailed.current = true;
        setState({ status: 'dismissed' });
        return;
      }
      if (
        event.type !== 'rejected' &&
        (event.type !== 'recording' ||
          (previous?.status === 'active' && previous.step === 'record'))
      )
        track(EVENTS.ONBOARDING_STEP_COMPLETED, {
          step: previous?.status === 'active' ? previous.step : 'create',
          action: event.type,
          note_id: event.noteId,
        });
      setState(next);
      if (next.status === 'completed')
        track(EVENTS.ONBOARDING_COMPLETED, { note_id: event.noteId });
      if (saved && next.status === 'completed') {
        setDoneOpen(true);
        void celebrateOnboarding(isCurrent);
      }
    },
    [key, org, isCurrent, track]
  );

  React.useEffect(() => {
    if (active && candidate?.recordingId)
      notify({ type: 'review', noteId: active.noteId, recordingId: candidate.recordingId });
  }, [active, candidate, notify]);

  const failedRecording = useAutoEnhanceStore(s => s.failedRecordingId);
  React.useEffect(() => {
    if (failedRecording && active?.recordingId === failedRecording)
      notify({ type: 'error', noteId: active.noteId, code: 'enhance_failed' });
  }, [failedRecording, active?.recordingId, active?.noteId, notify]);

  const restart = () => {
    if (!isCurrent() || !notes.isSuccess || !replayAvailable(key, notes.data?.length ?? 0)) return;
    const next: Walkthrough = { status: 'offered', replay: true, started: true };
    if (!writeWalkthrough(key, next)) return;
    setState(next);
    track(EVENTS.ONBOARDING_STARTED, { replay: true });
    navigation.push('/home');
  };

  const begin = () => {
    if (!isCurrent() || state?.status !== 'offered' || state.started) return;
    const next: Walkthrough = { ...state, started: true };
    if (!writeWalkthrough(key, next)) return;
    setState(next);
    track(EVENTS.ONBOARDING_STARTED, { replay: false });
  };

  const dismiss = () => {
    if (!isCurrent()) return;
    track(EVENTS.ONBOARDING_DISMISSED, { step: active?.step ?? 'create' });
    writeWalkthrough(key, { status: 'dismissed' });
    setState({ status: 'dismissed' });
  };
  const visible =
    (state?.status === 'offered' && !!state.started && pathname === '/home') ||
    (!!active && pathname === `/notes/${active.noteId}`);
  const step = active?.step ?? 'create';
  React.useLayoutEffect(() => {
    handlers.current = { notify, restart };
    publish({ scope, active, canReplay });
    return () => {
      handlers.current = null;
    };
  });
  return (
    <>
      {visible ? (
        <AnchoredTour
          step={step}
          onExit={dismiss}
          onError={code => notify({ type: 'error', code })}
          onContinue={() => {
            if (active) notify({ type: 'continue', noteId: active.noteId });
          }}
        />
      ) : null}
      <OnboardingWelcomeDialog
        open={state?.status === 'offered' && !state.started && pathname === '/home'}
        onStart={begin}
        onClose={dismiss}
      />
      <OnboardingCompletionDialog open={doneOpen} onClose={() => setDoneOpen(false)} />
    </>
  );
}
