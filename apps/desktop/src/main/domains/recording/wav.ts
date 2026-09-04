/**
 * WAV byte encoding for the recording pipeline.
 *
 * `encodeWavPcm16` turns a Float32 PCM buffer into a self-contained, byte-valid
 * `audio/wav` — mono 16-bit integer PCM with a correct RIFF/fmt/data header.
 * This is the exact container the transcribe endpoint requires (the
 * server 400s a malformed WAV), and it mirrors the web path's `encodeWavPcm16`
 * (packages/app-client/src/recording/wav-encode.ts) so mic and system chunks use
 * the same wire shape. Each chunk the chunker cuts becomes one
 * standalone WAV via this — a valid file on its own, header sizes filled in
 * (never a placeholder), so the upload lane never sends a truncated container.
 *
 * Defined desktop-side (not imported from app-client) so MAIN takes no
 * @prismical/app-client dependency for the recording lane — web stays byte-identical.
 */

/** RIFF/fmt/data header length for canonical 16-bit PCM (no extra chunks). */
const WAV_HEADER_BYTES = 44;

const writeAscii = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
};

/**
 * Float32 PCM → 16-bit integer PCM mono WAV. Out-of-range samples are clamped to
 * [-1, 1] (never wrapped), matching the transplanted StreamingWavWriter and the
 * web encoder. The returned bytes are a complete, standalone WAV with correct
 * RIFF size (dataBytes + 36) and data size (dataBytes) — no post-hoc fixup.
 */
export const encodeWavPcm16 = (samples: Float32Array, sampleRate: number): Uint8Array => {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF chunk.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size - 8
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk.
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true); // audio format = integer PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * bytesPerSample
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample

  // data sub-chunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(WAV_HEADER_BYTES + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Uint8Array(buffer);
};
