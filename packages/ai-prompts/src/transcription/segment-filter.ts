import { HALLUCINATION_PHRASES } from './hallucination-phrases.js';

// Dataset entries omit sentence punctuation, which the decoder commonly adds.
function normalizePhrase(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}

const knownPhrases = new Set([...HALLUCINATION_PHRASES, 'i love you'].map(normalizePhrase));

export interface WhisperSegmentQuality {
  text: string;
  noSpeechProb?: number;
  avgLogprob?: number;
  compressionRatio?: number;
  temperature?: number;
}

/** Drop likely non-speech output, while preserving longer, confident speech. */
export function shouldDropSegment(segment: WhisperSegmentQuality): boolean {
  const nsp = segment.noSpeechProb ?? 0;
  const temp = segment.temperature ?? 0;
  const alp = segment.avgLogprob;
  const cr = segment.compressionRatio;
  const text = normalizePhrase(segment.text);

  // Phrase membership alone is not evidence of silence: real speech can say "thank you".
  if (nsp > 0.4 && knownPhrases.has(text)) return true;

  // Short stereotypical phrases can have good confidence even on silence.
  if (
    alp !== undefined &&
    alp > -0.5 &&
    cr !== undefined &&
    cr < 2.0 &&
    segment.text.trim().length > (temp === 0 ? 20 : 25)
  )
    return false;

  return temp >= 1 || nsp > 0.8 || (nsp > 0.6 && alp !== undefined && alp < -1.0);
}

/** Metrics as returned by a Whisper-compatible verbose_json endpoint. */
export interface WhisperResponseSegment {
  text: string;
  no_speech_prob?: number | null;
  avg_logprob?: number | null;
  compression_ratio?: number | null;
  temperature?: number | null;
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function shouldDropWhisperSegment(segment: WhisperResponseSegment): boolean {
  return shouldDropSegment({
    text: segment.text,
    noSpeechProb: finiteMetric(segment.no_speech_prob),
    avgLogprob: finiteMetric(segment.avg_logprob),
    compressionRatio: finiteMetric(segment.compression_ratio),
    temperature: finiteMetric(segment.temperature),
  });
}

/**
 * Filter raw response segments before replacements or persistence. Missing segment metadata
 * keeps the original text; dropping every returned segment must never restore that text.
 */
export function filterWhisperTranscript(text: string, body: unknown): string {
  const segments = (body as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return text;
  if (!segments.every(s => s !== null && typeof s === 'object' && typeof s.text === 'string')) {
    return text;
  }
  const kept = (segments as WhisperResponseSegment[]).filter(s => !shouldDropWhisperSegment(s));
  if (kept.length === segments.length) return text;
  return kept
    .map(s => s.text)
    .join('')
    .trim();
}
