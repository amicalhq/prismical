import { useRef, useState } from "react";
import { api } from "@/trpc/react";
import type { MeetingLevels } from "@/types/meeting";

const EMPTY: MeetingLevels = { mic: 0, system: 0 };

// Asymmetric envelope: instant attack, slow release. At ~30Hz updates,
// 0.9 gives a ~220ms half-life — bars rise the moment audio arrives but
// decay smoothly when speech pauses, instead of snapping back to silent.
// Higher value (closer to 1) = longer trail.
const DECAY = 0.9;

// Subscribes to the meeting `levelUpdates` tRPC stream (per-source mic/system
// RMS amplitude, normalised 0-1) so waveform UIs can render a real-audio
// reaction instead of a fake interval pulse. Updates arrive at ~30Hz.
export function useMeetingLevel(): MeetingLevels {
  const [levels, setLevels] = useState<MeetingLevels>(EMPTY);
  const smoothedRef = useRef<MeetingLevels>(EMPTY);

  api.meetings.levelUpdates.useSubscription(undefined, {
    onData: (next) => {
      const smoothed: MeetingLevels = {
        mic: Math.max(next.mic, smoothedRef.current.mic * DECAY),
        system: Math.max(next.system, smoothedRef.current.system * DECAY),
      };
      smoothedRef.current = smoothed;
      setLevels(smoothed);
    },
    onError: (error) => {
      console.error("useMeetingLevel subscription error:", error);
    },
  });

  return levels;
}

// Threshold + saturation mapping for the waveform.
//
// `raw` is the per-source amplitude from MeetingManager.normalizeLevel,
// which already does `RMS × 4` and clamps to 1. The waveform is a
// "are we hearing you?" indicator, not a VU meter — we want:
//
//   - ambient noise / silence → bars flat (below NOISE_FLOOR → 0)
//   - any real speech → bars saturated quickly (above SATURATION → 1)
//   - normal vs loud speech → look similar (both pinned near 1)
//
// Tune NOISE_FLOOR up if room noise lights the bars; tune SATURATION
// down if normal conversation doesn't pin them.
const NOISE_FLOOR = 0.05;
const SATURATION = 0.1;

export function combinedLevel(levels: MeetingLevels): number {
  const raw = Math.max(levels.mic, levels.system);
  if (raw <= NOISE_FLOOR) return 0;
  const normalized = (raw - NOISE_FLOOR) / (SATURATION - NOISE_FLOOR);
  // sqrt() pushes the lower half of the post-threshold range up so even
  // soft speech reads as near-max. Combined with the tight saturation
  // window above, this makes the bars binary-ish: silent below floor,
  // pinned high for any actual speech.
  return Math.min(1, Math.sqrt(normalized));
}
