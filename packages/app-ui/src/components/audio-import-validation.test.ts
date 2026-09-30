// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { validateImportFile } from './audio-import-validation';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const file = (header: string) =>
  ({
    name: 'meeting.mp4',
    slice: () => ({ arrayBuffer: async () => new TextEncoder().encode(header).buffer }),
  }) as unknown as File;

it('rejects a renamed non-media file before loading metadata', async () => {
  const create = vi.spyOn(document, 'createElement');
  await expect(validateImportFile(file('not an audio file'), 3600)).rejects.toThrow('invalid');
  expect(create).not.toHaveBeenCalled();
});

it.each([
  [38, undefined],
  [3601, 'duration'],
  [Infinity, undefined],
  [0, undefined],
])('validates local duration %s and releases the object URL', async (duration, error) => {
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke });
  const media = {
    duration,
    onloadedmetadata: null as null | (() => void),
    onerror: null,
    load: vi.fn(),
    removeAttribute: vi.fn(),
    preload: '',
    set src(_value: string) {
      queueMicrotask(() => this.onloadedmetadata?.());
    },
  };
  vi.spyOn(document, 'createElement').mockReturnValue(media as unknown as HTMLAudioElement);
  const result = await validateImportFile(file('0000ftypisom0000'), 3600).then(
    () => undefined,
    (cause: Error) => cause.message
  );
  expect(result).toBe(error);
  expect(revoke).toHaveBeenCalledWith('blob:test');
  expect(media.load).toHaveBeenCalledOnce();
});

it.each([
  ['flac', [102, 76, 97, 67]],
  ['ogg', [79, 103, 103, 83]],
  ['oga', [79, 103, 103, 83]],
  ['opus', [79, 103, 103, 83]],
  ['webm', [26, 69, 223, 163]],
  ['aac', [255, 241, 80, 128]],
])(
  'defers valid %s headers to the server when browser decoding fails',
  async (extension, bytes) => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke });
    const media = {
      onerror: null as null | (() => void),
      onloadedmetadata: null,
      load: vi.fn(),
      removeAttribute: vi.fn(),
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      },
    };
    vi.spyOn(document, 'createElement').mockReturnValue(media as unknown as HTMLAudioElement);
    const input = {
      name: `test.${extension}`,
      slice: () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }),
    } as unknown as File;
    await expect(validateImportFile(input, 3600)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledOnce();
  }
);

it('defers a metadata timeout to the server and cleans up', async () => {
  vi.useFakeTimers();
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke });
  const media = { load: vi.fn(), removeAttribute: vi.fn() };
  vi.spyOn(document, 'createElement').mockReturnValue(media as unknown as HTMLAudioElement);
  const pending = validateImportFile(file('0000ftypisom0000'), 3600);
  await vi.advanceTimersByTimeAsync(3000);
  await expect(pending).resolves.toBeUndefined();
  expect(revoke).toHaveBeenCalledOnce();
});

it.each(['flac', 'ogg', 'oga', 'opus', 'webm', 'aac', 'mov'])(
  'rejects mismatched headers for %s',
  async extension => {
    const input = { ...file('0000ftypisom0000'), name: `test.${extension}` };
    await expect(validateImportFile(input as File, 3600)).rejects.toThrow('invalid');
  }
);
