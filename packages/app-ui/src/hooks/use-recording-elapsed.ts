'use client';

import * as React from 'react';
import type { UseRecording } from '@prismical/app-client';

/** Native windows use main's media clock; browser capture banks elapsed time across pauses. */
export function useRecordingElapsed(
  rec: Pick<UseRecording, 'state' | 'startedAt' | 'nativeElapsed'>
): number {
  // Retain the saved duration after Stop until the next recording starts.
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  // `seeded` is an explicit flag, NOT inferred from baseSeconds===0 — a pause
  // banked within the first second leaves base at 0 and an inferred sentinel
  // would then re-seed from wall clock on resume, counting the whole pause.
  const timerAnchorRef = React.useRef<{
    baseSeconds: number;
    runningSince: number | null;
    seeded: boolean;
  }>({ baseSeconds: 0, runningSince: null, seeded: false });
  const recStartedAt = rec.startedAt;
  const nativeElapsed = rec.nativeElapsed;
  React.useEffect(() => {
    if (rec.state === 'starting') {
      // New session engaging: reset (the previous session's value was held for
      // the "Saved · t" bar until now).
      timerAnchorRef.current = { baseSeconds: 0, runningSince: null, seeded: true };
      setElapsedSeconds(0);
      return;
    }
    if (nativeElapsed) {
      const tick = () => {
        const elapsedMs =
          nativeElapsed.elapsedMs +
          (rec.state === 'recording' &&
          nativeElapsed.status === 'recording' &&
          nativeElapsed.elapsedAt != null
            ? Math.max(0, Date.now() - nativeElapsed.elapsedAt)
            : 0);
        setElapsedSeconds(Math.max(0, Math.floor(elapsedMs / 1000)));
      };
      tick();
      if (rec.state !== 'recording') return;
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
    const anchor = timerAnchorRef.current;
    const seedFromWallClock = () =>
      recStartedAt ? Math.max(0, Math.round((Date.now() - Date.parse(recStartedAt)) / 1000)) : 0;
    if (rec.state === 'paused' && !anchor.seeded) {
      // Browser fallback for a hook mounted into an already-paused session.
      timerAnchorRef.current = {
        baseSeconds: seedFromWallClock(),
        runningSince: null,
        seeded: true,
      };
      setElapsedSeconds(timerAnchorRef.current.baseSeconds);
      return;
    }
    if (rec.state === 'recording') {
      if (timerAnchorRef.current.runningSince === null) {
        const base = timerAnchorRef.current.seeded
          ? timerAnchorRef.current.baseSeconds
          : seedFromWallClock();
        timerAnchorRef.current = { baseSeconds: base, runningSince: Date.now(), seeded: true };
      }
      const tick = () => {
        const a = timerAnchorRef.current;
        setElapsedSeconds(
          a.baseSeconds +
            (a.runningSince !== null ? Math.round((Date.now() - a.runningSince) / 1000) : 0)
        );
      };
      tick();
      const id = setInterval(tick, 1000);
      return () => {
        clearInterval(id);
        // Leaving 'recording' (pause or stop): bank the run into baseSeconds.
        const a = timerAnchorRef.current;
        if (a.runningSince !== null) {
          timerAnchorRef.current = {
            baseSeconds: a.baseSeconds + Math.round((Date.now() - a.runningSince) / 1000),
            runningSince: null,
            seeded: true,
          };
        }
      };
    }
  }, [rec.state, recStartedAt, nativeElapsed]);

  return elapsedSeconds;
}
