/**
 * Minimal RIFF/WAVE header parser for uploaded transcription chunks. We only accept
 * integer-PCM mono — that is what the web client produces — and we derive the chunk's
 * authoritative duration from the data length (provider-independent; defined even when
 * the provider returns no transcript). Throws WavParseError on anything malformed.
 */

export class WavParseError extends Error {}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the first PCM sample (the `data` chunk payload) within the buffer. */
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 44) throw new WavParseError('file too small for a WAV header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavParseError('not a RIFF/WAVE file');
  }

  // Walk chunks to find `fmt ` and `data` (don't assume fixed offsets — encoders may
  // insert LIST/INFO chunks between them).
  let fmt: { formatCode: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes: number | null = null;
  let dataOffset: number | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (off + 8 + 16 > buf.length) throw new WavParseError('truncated fmt chunk');
      fmt = {
        formatCode: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      dataOffset = off + 8;
      dataBytes = Math.min(size, buf.length - (off + 8));
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new WavParseError('missing fmt chunk');
  if (dataBytes === null || dataOffset === null) throw new WavParseError('missing data chunk');
  if (fmt.formatCode !== 1) throw new WavParseError(`unsupported WAV format code ${fmt.formatCode} (need integer PCM)`);
  if (fmt.channels !== 1) throw new WavParseError(`unsupported channel count ${fmt.channels} (need mono)`);
  if (fmt.sampleRate <= 0 || fmt.bitsPerSample <= 0) throw new WavParseError('invalid fmt values');

  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataOffset,
    dataBytes,
    durationMs: Math.round((dataBytes / bytesPerSecond) * 1000),
  };
}

/**
 * The raw PCM payload of a parsed WAV — a view (no copy) onto the `data` chunk bytes. This is what
 * the live-lane spool keeps per chunk: header-free, so the stitched lane carries exactly one
 * header and the payloads concatenate into valid audio.
 */
export function wavPcmPayload(buf: Buffer, info: WavInfo): Buffer {
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
}

/** ~1% of full scale: a live mic's noise floor sits well above this; digital near-silence below. */
export const SILENCE_PEAK_THRESHOLD = 330;

/**
 * Peak |sample| of a parsed integer-PCM16 WAV, 0..32767. Drives the whisper-class silence guard:
 * whisper-class decoders hallucinate plausible text on near-silent audio, so quiet chunks are
 * short-circuited before the decoder runs.
 */
export function pcmPeak(buf: Buffer, stopAt = 32767): number {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const start = off + 8;
      const end = Math.min(buf.length, start + size) - 1;
      let peak = 0;
      for (let i = start; i + 1 <= end; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > peak) peak = v;
        // The guard only needs "quieter than stopAt?" — real speech exits within a few
        // hundred samples instead of scanning a whole 25MB body.
        if (peak >= stopAt) return peak;
      }
      return peak;
    }
    off += 8 + size + (size % 2);
  }
  return 0;
}
