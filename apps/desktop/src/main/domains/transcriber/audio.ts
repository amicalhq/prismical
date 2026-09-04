/**
 * Audio helpers shared by the on-device lanes: the
 * near-silence guard and the 48 kHz → 16 kHz resample every whisper-class
 * engine needs (whisper.cpp and every OpenAI-compatible whisper endpoint take
 * 16 kHz; the chunker hands the lanes the capture's 48 kHz Float32).
 */
import { SILENCE_PEAK_THRESHOLD } from '@prismical/ai-prompts/transcription';
import { StreamingLinearResampler } from '../../infra/audio/streaming-linear-resampler';
import { CAPTURE_SAMPLE_RATE } from '../recording/chunker';

/** What whisper.cpp / the whisper endpoints decode. */
export const WHISPER_SAMPLE_RATE = 16_000;

/**
 * The shared near-silence threshold expressed for Float32 samples:
 * 330 / 32767 ≈ 0.01007.
 * Whisper-class engines hallucinate on near-silence, so a chunk under this
 * peak is acked EMPTY without touching the engine. Early-exits on the first
 * sample at/over the threshold, like `pcmPeak(buf, stopAt)`.
 */
export const SILENCE_PEAK_FLOAT = SILENCE_PEAK_THRESHOLD / 32767;

export const isNearSilence = (samples: Float32Array): boolean => {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) >= SILENCE_PEAK_FLOAT) return false;
  }
  return true;
};

/** A fresh 48 kHz → 16 kHz resampler (the local lane keeps one per recording lane for continuity). */
export const makeWhisperResampler = (): StreamingLinearResampler =>
  new StreamingLinearResampler(CAPTURE_SAMPLE_RATE, WHISPER_SAMPLE_RATE);

/** Stateless one-shot resample of a whole chunk (process + flush) — the BYOK lane's shape. */
export const resampleChunkForWhisper = (samples: Float32Array): Float32Array => {
  const resampler = makeWhisperResampler();
  const head = resampler.process(samples);
  const tail = resampler.flush();
  if (tail.length === 0) return head;
  const out = new Float32Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
};
