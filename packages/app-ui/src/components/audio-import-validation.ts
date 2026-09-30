export const IMPORT_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  'mp4',
  'flac',
  'ogg',
  'oga',
  'opus',
  'webm',
  'aac',
];
export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.map(extension => `.${extension}`).join(',');

/** Cheap local preflight only; the server still verifies codecs, tracks and actual duration. */
export async function validateImportFile(file: File, maxSeconds: number): Promise<void> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const text = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  const extension = file.name.split('.').pop()?.toLowerCase();
  const validHeader = (() => {
    switch (extension) {
      case 'wav':
        return text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE';
      case 'mp3':
        return text(0, 3) === 'ID3' || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0);
      case 'm4a':
      case 'mp4':
        return text(4, 8) === 'ftyp';
      case 'flac':
        return text(0, 4) === 'fLaC';
      case 'ogg':
      case 'oga':
      case 'opus':
        return text(0, 4) === 'OggS';
      case 'webm':
        return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
      case 'aac':
        return text(0, 3) === 'ID3' || (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0);
      default:
        return false;
    }
  })();
  if (!validHeader) throw new Error('invalid');

  await new Promise<void>((resolve, reject) => {
    const media = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
      if (error) reject(new Error(error));
      else resolve();
    };
    // Browser decoding support varies. Unknown duration is checked authoritatively by the server.
    const timer = setTimeout(() => finish(), 3_000);
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      if (Number.isFinite(media.duration) && media.duration > maxSeconds) finish('duration');
      else finish();
    };
    media.onerror = () => finish();
    media.src = url;
  });
}
