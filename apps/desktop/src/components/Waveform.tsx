import { motion } from "framer-motion";

interface WaveformProps {
  index: number;
  isRecording: boolean;
  // Real-time amplitude in [0, 1]. Drives the *envelope* (bar height) only;
  // the wavy oscillation is decoupled and runs at fixed amplitude so it
  // doesn't restart on every level update.
  level: number;
  baseHeight?: number;
  silentHeight?: number;
}

// Per-bar height factor — gives the row a "mountain" silhouette.
const BAR_FACTORS = [0.6, 0.85, 1.0, 1.0, 0.85, 0.6];

// Below this normalised level we settle to a single height with no wave —
// keeps quiet bars visibly flat rather than oscillating around silent.
const WAVE_THRESHOLD = 0.05;

// Module-level constants so framer-motion sees stable references across
// renders. Recreating the keyframe array on every render is what was
// causing the flicker — framer-motion was restarting the animation each
// time.
const SCALE_WAVE = [1, 1.2, 1, 0.8, 1];
const SCALE_FLAT = 1;

export function Waveform({
  index,
  isRecording,
  level,
  baseHeight = 60,
  silentHeight = 20,
}: WaveformProps) {
  if (!isRecording) {
    return <div className="h-[15%] w-1 rounded-full bg-white" />;
  }

  const factor = BAR_FACTORS[index % BAR_FACTORS.length] ?? 1;
  const range = baseHeight - silentHeight;
  const clamped = Math.min(1, Math.max(0, level));
  const center = silentHeight + range * clamped * factor;
  const isWaving = clamped > WAVE_THRESHOLD;

  return (
    <motion.div
      className="w-1 rounded-full bg-white"
      animate={{
        // Envelope: smooth single-value tween. Changes with level. No
        // keyframe restart concerns because it's just a target.
        height: `${center}%`,
        // Wave: fixed keyframes that never change, so the scaleY animation
        // keeps looping cleanly even as height transitions to new levels.
        scaleY: isWaving ? SCALE_WAVE : SCALE_FLAT,
      }}
      transition={{
        height: { duration: 0.15, ease: "easeOut" },
        scaleY: {
          duration: 0.9,
          ease: "easeInOut",
          repeat: isWaving ? Number.POSITIVE_INFINITY : 0,
          repeatType: "loop",
          // Per-bar phase offset creates a traveling-wave look across the
          // row — adjacent bars peak at slightly different times.
          delay: isWaving ? index * 0.08 : 0,
        },
      }}
    />
  );
}
