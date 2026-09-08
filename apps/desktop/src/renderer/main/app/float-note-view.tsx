/**
 * The floating note view — the dock's expanded mode, rendered
 * by the float-note window at #/float[/:noteId] over the SAME renderer bundle
 * and providers as the main app (the mount branches on the hash: no AppShell,
 * no auth-gate root, transparent page).
 *
 * Window visual language: no header divider — the header is
 * an overlay strip whose gradient scrim fades content beneath; note glyph +
 * title top-left as CHROME not content (muted, medium); controls ⇱ · + · ✕
 * grouped top-right in one translucent mini-pill; the whole strip is the
 * native drag region (app-region), edges resize natively (no drawn
 * affordance); the shared NoteRecordingDock is centred at the bottom.
 *
 * Slot semantics live in MAIN's FloatBridge; this view resolves the slot-LESS
 * case (`/float`, no id): the live recording's note if one exists, else it
 * creates a fresh quick note and reports it back (float:open keeps the slot
 * honest). The quick note is created on open rather than on first keystroke
 * because robust Yjs mounting is more important than avoiding a rare empty note.
 */
import * as React from 'react';
import { captureRendererException } from '../../telemetry';
import { ArrowUpLeft, FileText, Plus, SquareArrowOutUpRight, X } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@prismical/app-ui/ui/command';
import { useTranslation } from 'react-i18next';
import {
  useCreateNote,
  useDeviceSettings,
  useNote,
  useNotes,
  useRecording,
} from '@prismical/app-client';
import { NoteTitleField } from '@prismical/app-ui/components/note-title-field';
import { NoteBodyEditor } from '@prismical/app-ui/components/note-body-editor';
import { RecordingBottomCluster } from '@prismical/app-ui/components/recording-bottom-cluster';
import {
  CurrentNoteProvider,
  useRegisterCurrentNote,
} from '@prismical/app-ui/shell/current-note-context';
import { CurrentEditorProvider } from '@prismical/app-ui/shell/current-editor-context';

const CHROME_BUTTON_CLASS =
  'flex size-6 items-center justify-center rounded-md text-dock-ink-3 transition-colors hover:bg-dock-hover hover:text-dock-ink';

/** The hover-revealed top-right cluster uses the same elevated treatment as the
 * dock panels' action cluster. */
const FLOAT_CLUSTER_CLASS =
  'flex flex-none items-center gap-0.5 rounded-[10px] border border-dock-line bg-[color-mix(in_srgb,var(--dock-ink)_4%,var(--dock-surface))] p-0.5 shadow-[var(--dock-shadow-btn),0_4px_14px_rgba(0,0,0,0.16)] opacity-0 transition-opacity duration-150 group-hover/float:opacity-100 group-focus-within/float:opacity-100';

// The dock-initiated start intent (?autostart=1, the expansion rule). It
// survives the resolver→note navigation (main's navPush retarget carries no
// search params) by parking module-side — safe: the float window is a
// dedicated renderer. Two states guard against firing on the WRONG note:
//   armed  — the intent exists but its note isn't known yet (slot-less route);
//   noteId — BOUND to the note it was minted for; only that note's body may
//            consume it, and a body for any OTHER note kills it (its nav lost
//            a race — a stale intent must never surprise-start elsewhere).
const autoStartIntent: { armed: boolean; noteId: string | null } = {
  armed: false,
  noteId: null,
};

/**
 * Graceful degradation for the float: the routes' error
 * component. A raw error screen in an always-on-top window is a trap — the
 * default boundary strips the header chrome, leaving no way to dismiss the
 * window. This fallback keeps a drag strip and WORKING controls (the float
 * IPC verbs don't depend on React state), says something human, and offers a
 * reload. It only reads the outer application-locale provider, which mounts
 * before the router and remains available when a route/provider below fails.
 */
export function FloatErrorFallback({ error }: { error: unknown }) {
  React.useEffect(() => captureRendererException(window.desktop.telemetry, error, 'react_error_boundary'), [error]);
  const { t } = useTranslation();
  return (
    <div className="h-screen w-screen p-0">
      <div className="bg-background ring-border/60 flex h-full w-full flex-col overflow-hidden rounded-xl shadow-2xl ring-1">
        <div
          className="flex h-11 flex-none items-center justify-end px-3"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div
            className="flex flex-none items-center gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5 ring-1 ring-foreground/10"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              className={CHROME_BUTTON_CLASS}
              aria-label={t('desktop.float.backToApp')}
              title={t('desktop.float.backToApp')}
              onClick={() => window.desktop.float.dockBack()}
            >
              <ArrowUpLeft className="size-3.5" />
            </button>
            <button
              type="button"
              className={CHROME_BUTTON_CLASS}
              aria-label={t('desktop.float.close')}
              title={t('desktop.float.close')}
              onClick={() => window.desktop.float.collapse()}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('desktop.float.errorTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('desktop.float.errorDescription')}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-foreground/10 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/15"
            onClick={() => window.location.reload()}
          >
            {t('desktop.float.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The slot-less entry: the live recording's note if any, else a quick note. */
function FloatSlotResolver({ fresh }: { fresh: boolean }) {
  const { t } = useTranslation();
  const createNote = useCreateNote();
  const createNoteRef = React.useRef(createNote);
  createNoteRef.current = createNote;
  const startedRef = React.useRef(false);
  // isPending is exactly "the sync store hasn't published yet" — create()
  // THROWS before then, and a fresh float window mounts this resolver before
  // the SyncStoreProvider's async build settles. The effect re-runs on the
  // flip and creates then.
  const storeReady = !createNote.isPending;

  React.useEffect(() => {
    if (startedRef.current) return;
    // ONE navigation source: float.open updates MAIN's slot, and main's
    // navPush retargets this window through the nav drain — a local
    // history.push too would double the history entry.
    const goTo = (noteId: string) => {
      // Hand the parked intent its note before the nav: the body consumes it
      // only when ITS noteId matches.
      if (autoStartIntent.armed) {
        autoStartIntent.armed = false;
        autoStartIntent.noteId = noteId;
      }
      window.desktop.float.open(noteId);
    };
    const beginCreate = () => {
      startedRef.current = true;
      try {
        createNoteRef.current.mutate(undefined, {
          onSuccess: note => goTo(note.id),
        });
      } catch {
        // The store vanished between the readiness check and the create (a
        // sign-out race) — allow a later effect re-run to retry rather than
        // letting the throw feed the route error boundary (which would strip
        // the ✕/⇱ chrome from an always-on-top window).
        startedRef.current = false;
      }
    };
    // A dock-initiated start (?fresh=1) bypasses the live-recording lookup:
    // the fresh recording gets its OWN new note, always.
    if (fresh) {
      if (storeReady) beginCreate();
      return; // not ready yet — the storeReady re-run creates
    }
    // The preload buffer replays the LATEST recording state synchronously when
    // one was ever pushed — a live recording's note wins the slot. If nothing
    // replays (no recording this session), the microtask falls through to a
    // fresh quick note (deferred until the store publishes).
    const resolve = (liveNoteId: string | null) => {
      if (startedRef.current) return;
      if (liveNoteId !== null) {
        startedRef.current = true;
        goTo(liveNoteId);
        return;
      }
      if (storeReady) beginCreate();
    };
    const unsubscribe = window.desktop.recording.onStateChanged(state => {
      resolve(state.status !== 'idle' && state.noteId ? state.noteId : null);
    });
    queueMicrotask(() => resolve(null));
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, storeReady]);

  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t('desktop.float.opening')}
    </div>
  );
}

/**
 * The header title as CHROME that EDITS: an inline input styled like the old
 * muted label; commits on blur/Enter (LWW title patch, same as the in-app
 * header), Escape cancels. no-drag — the rest of the strip still drags.
 */

function FloatNoteBody({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const note = useNote(noteId);
  const rec = useRecording();
  const createNote = useCreateNote();

  // Publish to the recording cluster context so the dock face is the note dock.
  useRegisterCurrentNote(
    note.data
      ? { noteId: note.data.id, title: note.data.title, transcript: note.data.transcript ?? [] }
      : null
  );

  // The parked dock-initiated start (the expansion rule): fire once, and only
  // on the note the intent was BOUND to. A body for any other note kills the
  // intent outright — its navigation lost a race, and a stale intent must
  // never surprise-start a recording on a note the user merely popped out.
  // If something is already recording when the bound note arrives, the intent
  // is dropped (never a delayed surprise start).
  const noteReady = note.data?.id;
  const recIdle = rec.state === 'idle';
  // The start itself is DELEGATED to the bottom cluster (autoStartNoteId prop):
  // useRecording's `error` is per-hook-instance state, so a start made from
  // THIS view's instance failed invisibly — the cluster's error pill/banner
  // never saw it (the widget's silent-failure bug). The intent resolves here,
  // the cluster's own instance performs the start.
  const [pendingAutoStart, setPendingAutoStart] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (autoStartIntent.noteId === null) return;
    if (autoStartIntent.noteId !== noteId) {
      autoStartIntent.noteId = null;
      return;
    }
    if (!noteReady) return; // bound note, data not loaded yet — keep waiting
    autoStartIntent.noteId = null;
    if (recIdle) setPendingAutoStart(noteReady);
  }, [noteId, noteReady, recIdle]);

  // The in-window note switcher (⌘K).
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen(v => !v);
      }
      if (e.key === 'Escape') setSwitcherOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="group/float relative flex h-full flex-col">
      {/* ── Overlay header: a clean strip with the
             faint CENTERED title; hovering the window reveals the traffic-light
             close on the left and the action cluster on the right. The strip is
             the native drag region. ────────────────────────────────────────── */}
      <div
        className="absolute inset-x-0 top-0 z-50 flex h-11 items-center px-3"
        style={
          {
            WebkitAppRegion: 'drag',
            background: 'linear-gradient(to bottom, var(--background) 55%, transparent)',
          } as React.CSSProperties
        }
      >
        {/* Traffic lights (frameless window — drawn): red closes to the pill;
            the neutral pair is decorative, matching the reference chrome. */}
        <div
          className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-[7px] opacity-0 transition-opacity duration-150 group-hover/float:opacity-100 group-focus-within/float:opacity-100"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            aria-label={t('desktop.float.collapseToPill')}
            title={t('desktop.float.collapse')}
            onClick={() => window.desktop.float.collapse()}
            className="size-[11px] rounded-full bg-[#ff5f57] transition-[filter] hover:brightness-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <span
            aria-hidden
            className="size-[11px] rounded-full bg-[color-mix(in_srgb,var(--dock-ink)_22%,transparent)]"
          />
          <span
            aria-hidden
            className="size-[11px] rounded-full bg-[color-mix(in_srgb,var(--dock-ink)_22%,transparent)]"
          />
        </div>
        <span className="w-16 flex-none" />
        {/* The center is a DRAG region (inherits from the strip); only the
            fit-width icon+title pair opts out so it stays click-to-edit. The
            old flex-1 no-drag input ate the whole strip and left slivers to
            drag by (user feedback). */}
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <div
            className="flex min-w-0 max-w-[70%] items-center gap-1.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <FileText className="size-3.5 shrink-0 text-dock-ink-3" />
            {note.data && <NoteTitleField key={note.data.id} note={note.data} compact />}
          </div>
        </div>
        <span className="w-2 flex-none" />
        <div
          className={FLOAT_CLUSTER_CLASS}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            data-switcher-toggle
            className={CHROME_BUTTON_CLASS}
            aria-label={t('desktop.float.browseNotes')}
            title={t('desktop.float.browseNotes')}
            onClick={() => setSwitcherOpen(v => !v)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
            </svg>
          </button>
          <button
            type="button"
            className={CHROME_BUTTON_CLASS}
            aria-label={t('desktop.float.newQuickNote')}
            title={t('desktop.float.newQuickNote')}
            disabled={createNote.isPending}
            onClick={() =>
              createNote.mutate(undefined, {
                // float.open retargets this window via main's navPush — the
                // single navigation source (no local history.push double).
                onSuccess: fresh => window.desktop.float.open(fresh.id),
              })
            }
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            className={CHROME_BUTTON_CLASS}
            aria-label={t('desktop.float.dockBack')}
            title={t('desktop.float.dockBack')}
            onClick={() => window.desktop.float.dockBack()}
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </button>
        </div>
      </div>

      {/* ── ⌘K note switcher: an in-window palette; picking retargets the float. */}
      {switcherOpen ? (
        <FloatNoteSwitcher
          onPick={id => {
            setSwitcherOpen(false);
            window.desktop.float.open(id);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}

      {/* ── Body: the real note (same TipTap/Yjs doc as the app) ──────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-12">
        <NoteBodyEditor noteId={noteId} writable={note.data?.writable ?? true} />
      </div>

      {/* ── Bottom cluster: THE shared cluster (dock + transcript panel +
             Ask + skills) — identical to the in-app note view; both panels
             are collapsible and share one slot. It reads everything from the
             CurrentNote context this body already registers into. `compact`:
             while a recording is engaged the skill + Ask pills leave the row
             (the full row overflows this narrow window). ──────────────────── */}
      <RecordingBottomCluster
        compact
        autoStartNoteId={pendingAutoStart}
        onAutoStartConsumed={() => setPendingAutoStart(null)}
      />
    </div>
  );
}

/** The in-window ⌘K palette: search and note rows. */
function FloatNoteSwitcher({
  onPick,
  onClose,
}: {
  onPick: (noteId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: notes = [] } = useNotes();
  const rows = React.useMemo(() => [...notes].reverse().slice(0, 50), [notes]);
  // Light-dismiss: a pointerdown anywhere outside the palette closes it (the
  // note body, the dock, the header — Escape was the only way out before).
  // pointerdown, not click, so the palette is gone before the outside target's
  // own click handler runs.
  const paletteRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      // The header toggle handles its own close on click — closing here too
      // would make its click re-open the palette in the same gesture.
      if (target.closest('[data-switcher-toggle]')) return;
      if (paletteRef.current && !paletteRef.current.contains(target)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);
  return (
    // Command, not a hand-rolled input+rows: it supplies arrow-key selection,
    // Enter-on-highlight, listbox/option roles and the filtering the old
    // version wrote by hand (its Enter always picked row 0).
    <div
      ref={paletteRef}
      className="absolute inset-x-3 top-3 z-[60] overflow-hidden rounded-xl bg-dock-surface shadow-(--dock-shadow-raised)"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <Command
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Escape') onClose();
        }}
        // Dock-token restyle of the stock input wrapper (a slot, so a child
        // selector is the seam it offers).
        className="bg-transparent p-1 [&_[data-slot=command-input-wrapper]]:mx-0.5 [&_[data-slot=command-input-wrapper]]:mb-1 [&_[data-slot=command-input-wrapper]]:h-8 [&_[data-slot=command-input-wrapper]]:rounded-[7px] [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:bg-dock-field [&_[data-slot=command-input-wrapper]]:px-2 [&_[data-slot=command-input-wrapper]_svg]:size-[13px] [&_[data-slot=command-input-wrapper]_svg]:text-dock-ink-3"
      >
        <CommandInput
          autoFocus
          placeholder={t('desktop.float.searchNotes')}
          className="h-8 text-[12.5px] text-dock-ink placeholder:text-dock-ink-3"
        />
        <CommandList className="max-h-[248px]">
          <CommandEmpty className="px-2 py-3 text-[12.5px] text-dock-ink-3">
            {t('navigation.collections.noNotes')}
          </CommandEmpty>
          {rows.map(n => (
            <CommandItem
              key={n.id}
              value={`${n.title} ${n.id}`}
              onSelect={() => onPick(n.id)}
              className="flex h-[30px] items-center gap-2 rounded-md px-2 text-[12.5px] text-dock-ink data-[selected=true]:bg-dock-hover data-[selected=true]:text-dock-ink"
            >
              <FileText className="size-3.5 shrink-0 text-dock-ink-2" />
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
            </CommandItem>
          ))}
        </CommandList>
        <div className="mt-1 border-t border-dock-line px-2 pb-0.5 pt-1.5 text-2xs text-dock-ink-3">
          {t('desktop.float.switcherHint')}
        </div>
      </Command>
    </div>
  );
}

export function FloatNoteView({
  noteId,
  fresh = false,
  autoStart = false,
}: {
  noteId?: string;
  fresh?: boolean;
  autoStart?: boolean;
}) {
  // Park the autostart intent BEFORE the body can consume it (render-phase,
  // not an effect: FloatNoteBody's consuming effect may run first otherwise).
  // Idempotent under re-render/strict-mode. With the note already in the
  // route (?autostart on /float/:id — the future ambient auto-expand shape)
  // the intent binds immediately; slot-less it stays armed until the resolver
  // hands it the note it creates/resolves.
  if (autoStart) {
    if (noteId) {
      autoStartIntent.noteId = noteId;
      autoStartIntent.armed = false;
    } else {
      autoStartIntent.armed = true;
    }
  }
  // macOS: the WINDOW carries the frost (vibrancy 'menu' + system-rounded
  // corners, same recipe as the main window's sidebar) — the card goes
  // translucent so the material reads through, like the in-app sidebar.
  // Elsewhere the window is transparent and the card draws its own rounded
  // opaque chrome. window-chrome-mac doubles as the darwin signal.
  const { has } = useDeviceSettings();
  const isMac = has('window-chrome-mac');
  return (
    <CurrentNoteProvider>
      <CurrentEditorProvider>
        <div className="h-screen w-screen p-0">
          {/* The flat background keeps the header fade from forming a dark
              shadow band across the window. */}
          <div
            className={`ring-border/60 bg-background h-full w-full overflow-hidden rounded-[18px] ring-1 ${
              isMac ? '' : 'shadow-2xl'
            }`}
          >
            {noteId ? <FloatNoteBody noteId={noteId} /> : <FloatSlotResolver fresh={fresh} />}
          </div>
        </div>
      </CurrentEditorProvider>
    </CurrentNoteProvider>
  );
}
