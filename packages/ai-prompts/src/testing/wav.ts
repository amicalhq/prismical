/**
 * Build a minimal PCM WAV file buffer for tests. The data section is silence (zeros);
 * pass a sample count to fabricate N samples without allocating real audio.
 */
export function buildTestWav(opts: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  /** PCM format code; 1 = integer PCM. Use 3 to fabricate a float (non-PCM-int) file. */
  formatCode?: number;
  sampleCount?: number;
  /**
   * Sample value to fill the data section with. Default 0 (silence — the fake model
   * transcribes silence to an EMPTY transcript). Pass a nonzero value (e.g. 8000) for
   * "speech" that the fake model transcribes to its fixed text.
   */
  fill?: number;
}): Buffer {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const formatCode = opts.formatCode ?? 1;
  const sampleCount = opts.sampleCount ?? sampleRate; // default: 1 second
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = sampleCount * channels * bytesPerSample;

  const buf = Buffer.alloc(44 + dataBytes);
  if (opts.fill && bitsPerSample === 16) {
    for (let i = 0; i < sampleCount * channels; i++) buf.writeInt16LE(opts.fill, 44 + i * 2);
  }
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(formatCode, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}
