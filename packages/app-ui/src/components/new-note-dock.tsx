'use client';
import { useWalkthroughEvent } from '../onboarding/context';

import { useActiveOrgId, useActiveSessionKey, useNavigation } from '@prismical/app-client';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { useCreateNote } from '@prismical/app-client';
import { DOCK_PILL_CHROME } from './dock-chrome';
import { useTranslation } from 'react-i18next';

// The "New note" face of the bottom dock, shown on every page that ISN'T a note
// (where the dock instead morphs into the recording unit). It is icon-only —
// the tooltip carries the words (the labelled pill read as a bar, not a dock
// unit, next to the icon-sized recording pill). Chrome (DOCK_PILL_CHROME)
// matches the units so the dock reads as one element as it morphs per page.
// Creates a loose note via core (server-generated id) and opens it; the body
// row is lazily created on first edit. (Web-only divergence: desktop only
// shows the dock on a note.)
/**
 * How long a click will wait for the sync store. The store is null until its first pull settles
 * (every web boot is a cold pull, and it goes null again on an org/account switch), and a click in
 * that window used to be swallowed by `disabled`. Bounded so a click can never fire minutes later
 * against a screen the user has long since left.
 */
const CREATE_LATCH_MS = 8000;

export function NewNoteDock() {
  const { t } = useTranslation();
  const router = useNavigation();
  const createNote = useCreateNote();
  const walkthroughEvent = useWalkthroughEvent();
  const activeOrgId = useActiveOrgId();
  const activeSessionKey = useActiveSessionKey();
  // Not `disabled`: that swallowed the click outright, and `pointer-events-none` suppressed the
  // tooltip with it. Latch the intent instead and honour it when the store lands.
  const [queued, setQueued] = React.useState(false);
  const notReady = createNote.isPending;

  const failureRef = React.useRef(() => {});
  React.useLayoutEffect(() => {
    failureRef.current = () => {
      toast.error(t('common.mutationErrors.noteCreate'));
      walkthroughEvent({ type: 'error', code: 'create_failed' });
    };
  }, [t, walkthroughEvent]);

  const create = React.useCallback(() => {
    try {
      createNote.mutate(undefined, {
        onSuccess: note => {
          walkthroughEvent({ type: 'created', noteId: note.id });
          router.push(`/notes/${note.id}`);
        },
      });
    } catch {
      walkthroughEvent({ type: 'error', code: 'create_failed' });
      toast.error(t('common.mutationErrors.noteCreate'));
    }
  }, [createNote, router, walkthroughEvent, t]);

  const queuedOrgRef = React.useRef<string | null>(null);
  const queuedSessionRef = React.useRef<string | null>(null);

  // Expiry lives in its OWN effect keyed on `queued` alone. `useCreateNote` returns a fresh object
  // every render and this component re-renders on every navigation, so an expiry armed alongside
  // `create` in the deps below would be cleared and re-armed on each of those renders — the
  // deadline would never actually arrive, which is the one thing it exists to guarantee.
  React.useEffect(() => {
    if (!queued) return;
    const expire = setTimeout(() => {
      setQueued(false);
      failureRef.current();
    }, CREATE_LATCH_MS);
    return () => clearTimeout(expire);
  }, [queued]);

  React.useEffect(() => {
    if (!queued) return;
    // Same rule for the login session as for the org below: on a cold web load the shell paints
    // while the session is still refreshing, so a click in that first second queues with `null`.
    // The key resolving is not a switch - adopt it, and only drop on a change from that.
    const clickedSession = queuedSessionRef.current;
    if (clickedSession === null) {
      if (activeSessionKey !== null) queuedSessionRef.current = activeSessionKey;
    } else if (activeSessionKey !== clickedSession) {
      setQueued(false);
      failureRef.current();
      return;
    }
    // A switch mid-wait would land the note in the WRONG org's (or account's) partition — drop it,
    // don't guess. The org may not be known at click time though: null is both "not resolved yet"
    // on a cold load AND a durable "no pick" state (a cleared pick, or mobile web where the
    // switcher that resolves it is unmounted). Reading either as a switch threw the click away in
    // exactly the case this latch exists for.
    //
    // So: adopt the first org we actually see, then guard against changes from THAT. Without the
    // adoption a null-queued click stays unguarded for the latch's whole life, and a switch made
    // while waiting would create the note in whichever workspace the user landed in.
    const clickedOrg = queuedOrgRef.current;
    if (clickedOrg === null) {
      if (activeOrgId !== null) queuedOrgRef.current = activeOrgId;
    } else if (activeOrgId !== clickedOrg) {
      setQueued(false);
      failureRef.current();
      return;
    }
    if (notReady) return;
    setQueued(false);
    create();
  }, [queued, notReady, activeOrgId, activeSessionKey, create]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-onboarding="new-note"
            aria-busy={queued}
            onClick={() => {
              if (notReady) {
                queuedOrgRef.current = activeOrgId;
                queuedSessionRef.current = activeSessionKey;
                setQueued(true);
                return;
              }
              create();
            }}
            aria-label={t('notes.newNote')}
            className={`
              ${DOCK_PILL_CHROME} w-[52px] cursor-pointer justify-center
              active:scale-95 aria-busy:opacity-60
            `}
          >
            {/* The hover wash goes on a child that FILLS the pill, matching the recording unit's
                face (note-recording-dock.tsx). `--dock-hover` is translucent by design — it is
                meant to tint an opaque surface, not to be that surface. Setting it directly on
                this pill replaced `bg-dock-surface` and the pill went see-through on hover. */}
            <span
              className="
                flex h-full w-full items-center justify-center text-dock-ink-2
                transition-[background-color,color] group-hover:bg-dock-hover
                group-hover:text-dock-ink
              "
            >
              <Plus className={`size-[18px] shrink-0 ${queued ? 'animate-pulse' : ''}`} />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('notes.actions.createNew')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
