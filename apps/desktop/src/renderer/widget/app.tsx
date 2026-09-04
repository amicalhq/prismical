/**
 * The floating dock pill: a dumb view over
 * the typed widget IPC. It subscribes to `window.widget.onState` and renders
 * one of the pills off the pushed WidgetStateView; every action is a
 * fire-and-forget verb.
 *
 * The ~12 Hz `widget:level` subscription drives the
 * real waveform (with a staleness timeout back to the synthetic pulse), the
 * renderer-derived elapsed timer fields, pause/resume wiring (canPause-gated),
 * and SIDE MIRRORING — the pill aligns to whichever screen half it sits on
 * (left-snapped docks hug the left edge; the cluster + slide-in mirror). The
 * side derives locally from window.screenX (no IPC): recomputed on mount, on
 * every state push, and per drag sample.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { WidgetStateView } from '@prismical/desktop-contracts';
import { IdlePill } from './idle-pill';
import { RecordingPill } from './recording-pill';
import { DragHandle } from './widget-buttons';

type PendingAction = 'takingNotes' | null;
/** An in-flight drag: the grab's offset from the widget window's origin (px). */
type DragState = { pointerOffsetX: number; pointerOffsetY: number };

/** How long a pushed level stays "fresh" before the bars fall back to synthetic. */
const LEVEL_STALE_MS = 500;

/** Which screen half the window's centre sits on (multi-display safe: screenX
 * is global desktop coords, screen.availLeft is this display's origin). */
const computeSide = (): 'left' | 'right' => {
  const screenInfo = window.screen as Screen & { availLeft?: number };
  // availLeft/availWidth throughout — mixing availLeft with full `width` would
  // bias the midpoint by a left-pinned macOS Dock's width.
  const originX = screenInfo.availLeft ?? 0;
  const centre = window.screenX + window.outerWidth / 2;
  return centre - originX < screenInfo.availWidth / 2 ? 'left' : 'right';
};

export function WidgetApp({ initialState }: { initialState: WidgetStateView }) {
  const [state, setState] = useState<WidgetStateView>(initialState);
  const [isHovered, setIsHovered] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [side, setSide] = useState<'left' | 'right'>('right');
  const [level, setLevel] = useState<number | null>(null);
  const interactiveRef = useRef(false);

  // Subscribe to the pushed state (the buffer replays the latest to a late
  // subscriber); onState returns its unsubscribe, so it doubles as cleanup.
  useEffect(() => window.widget.onState(setState), []);

  // The ~12 Hz level lane is ephemeral: each push resets a staleness timer;
  // when pushes stop (recording ended, lane gated) the bars fall back to the
  // synthetic pulse rather than freezing on the last value.
  useEffect(() => window.widget.onLevel(setLevel), []);
  useEffect(() => {
    if (level === null) return;
    const id = setTimeout(() => setLevel(null), LEVEL_STALE_MS);
    return () => clearTimeout(id);
  }, [level]);

  // Side mirroring: recompute whenever the window may have moved — every
  // state push covers open/re-seed; drags recompute per sample below.
  useEffect(() => {
    setSide(computeSide());
  }, [state]);

  const visible = state.visible;
  const mode = state.mode;
  const dragging = dragState !== null;

  // Only toggle click-through on an actual change.
  const syncInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return;
    interactiveRef.current = next;
    window.widget.setInteractive(next);
  }, []);

  // Interactive while a hit-zone is hovered on a visible widget OR while dragging
  // (the drag must keep receiving pointer events as the window follows the cursor).
  useEffect(() => {
    syncInteractive((visible && isHovered) || dragging);
  }, [visible, isHovered, dragging, syncInteractive]);

  // During a drag session, window-level pointer listeners stream the pointer's
  // absolute screen position
  // to main (which repositions the window live, clamped + edge-snapped) and
  // commit + persist per display on release.
  useEffect(() => {
    if (!dragState) return;
    const onPointerMove = (event: PointerEvent) => {
      window.widget.dragMove(
        event.screenX,
        event.screenY,
        dragState.pointerOffsetX,
        dragState.pointerOffsetY
      );
      setSide(computeSide());
    };
    const onPointerUp = (event: PointerEvent) => {
      window.widget.dragEnd(
        event.screenX,
        event.screenY,
        dragState.pointerOffsetX,
        dragState.pointerOffsetY
      );
      setDragState(null);
      setIsHovered(false);
      setSide(computeSide());
    };
    // An OS-cancelled pointer (gesture takeover, display sleep) must not strand
    // the drag: the window would stay interactive (eating clicks) and the next
    // real pointerup would never come. Commit like a release at the last
    // position streamed — dragEnd persists it, matching what the user saw.
    const onPointerCancel = (event: PointerEvent) => {
      onPointerUp(event);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [dragState]);

  const handleDragStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // clientX/clientY are the grab point relative to the widget window's
    // origin, so main derives the new origin as screen - pointerOffset per axis.
    setDragState({ pointerOffsetX: event.clientX, pointerOffsetY: event.clientY });
    setIsHovered(true);
  }, []);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    setIsHovered(target?.closest("[data-hit-zone='true']") !== null && target !== null);
  }, []);
  const handleMouseLeave = useCallback(() => {
    // Keep the cluster "hovered" through an active drag even as the pointer
    // leaves — the pointerup handler clears it.
    if (!dragging) setIsHovered(false);
  }, [dragging]);

  // Optimistic pending flag: set on click, cleared when the next push changes
  // the mode (the state stream is the source of truth — no mutation state to
  // read). A start that never begins (no-session / permission-denied / busy —
  // the bridge folds them, no state transition follows) must not strand the
  // spinner: a timeout clears it so the Record affordance comes back.
  const [pending, setPending] = useState<PendingAction>(null);
  // The spinner timing out with the mode still idle means the start silently
  // failed (permission-denied / no-session — the bridge folds them, no state
  // transition ever arrives). Surface it: the pill flashes a warning state for
  // a few seconds instead of just snapping back to Record with no explanation;
  // clicking it opens the float note, where the real error banner lives.
  const [startFailed, setStartFailed] = useState(false);
  const modeRef = useRef(mode);
  useEffect(() => {
    if (modeRef.current !== mode) {
      modeRef.current = mode;
      setPending(null);
      if (mode === 'recording') setStartFailed(false);
    }
  }, [mode]);
  useEffect(() => {
    if (pending === null) return;
    const id = setTimeout(() => {
      setPending(null);
      if (modeRef.current === 'idle') setStartFailed(true);
    }, 5_000);
    return () => clearTimeout(id);
  }, [pending]);
  useEffect(() => {
    if (!startFailed) return;
    const id = setTimeout(() => setStartFailed(false), 8_000);
    return () => clearTimeout(id);
  }, [startFailed]);

  const handleRecord = useCallback(() => {
    setStartFailed(false);
    setPending('takingNotes');
    window.widget.startRecording();
  }, []);
  const handleStop = useCallback(() => window.widget.stopRecording(), []);
  const handlePause = useCallback(() => window.widget.pauseRecording(), []);
  const handleResume = useCallback(() => window.widget.resumeRecording(), []);
  // 📓 Note opens the float slot (the floating note window); the pill
  // body click opens the main app.
  const handleOpenNote = useCallback(() => window.widget.expandNote(), []);
  const handleOpenApp = useCallback(() => window.widget.openMain(), []);

  // Keep the pills expanded through a drag (the pointer may leave the pill).
  // A failed start also auto-expands the pill — the warning must be seen
  // without requiring a hover the user has no reason to perform.
  const hovered = visible && (isHovered || dragging || startFailed);
  const mirrored = side === 'left';

  return (
    <main
      className="h-screen w-screen bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={`flex h-full w-full items-center ${mirrored ? 'justify-start pl-1' : 'justify-end pr-1'}`}
      >
        <div
          data-hit-zone="true"
          className={`flex items-center gap-1.5 transition-all duration-200 ease-out ${mirrored ? 'flex-row-reverse' : ''} ${
            visible
              ? 'translate-x-0 opacity-100'
              : `pointer-events-none opacity-0 ${mirrored ? '-translate-x-6' : 'translate-x-6'}`
          }`}
        >
          <DragHandle shown={hovered} onPointerDown={handleDragStart} />
          {mode === 'recording' ? (
            <RecordingPill
              hovered={hovered}
              status={state.recording?.status ?? 'recording'}
              micOnly={state.recording?.micOnly ?? false}
              canPause={state.recording?.canPause ?? false}
              elapsedMs={state.recording?.elapsedMs ?? 0}
              elapsedAt={state.recording?.elapsedAt ?? null}
              level={level}
              onStop={handleStop}
              onPause={handlePause}
              onResume={handleResume}
              onOpenNote={handleOpenNote}
              onOpenApp={handleOpenApp}
            />
          ) : (
            <IdlePill
              hovered={hovered}
              onRecord={handleRecord}
              onOpenNote={handleOpenNote}
              recordPending={pending === 'takingNotes'}
              startFailed={startFailed}
            />
          )}
        </div>
      </div>
    </main>
  );
}
